import type { PhysicalPlanNode } from '../physical-plan.js';
import { DependentJoinOperator } from '../operators/dependent-join.js';
import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { PipelineGraph } from '../pipeline.js';
import { TaskScheduler } from '../scheduler.js';
import { Config } from '../../config.js';
import type {
  ColumnMapping,
  CompiledPipeline,
  ExecSchema,
  Sink,
  SourceGenerator,
} from '../execution-types.js';
import type {
  LogicalPlanNode,
  LogicalCTEAnchorNode,
  LogicalCTEScanNode,
  LogicalDependentJoinNode,
} from '../../planner/logical-plan.js';

export interface MaterializedCTE {
  chunks: DataChunk[];
  schema: ExecSchema;
  columnMapping: ColumnMapping;
}

interface ExecutorLike {
  buildPipeline(node: PhysicalPlanNode): Promise<CompiledPipeline>;
  buildLogicalPipeline(node: LogicalPlanNode): Promise<CompiledPipeline>;
  buildSchemaMapping(schema: ExecSchema, alias: string): ColumnMapping;
  findCTEPlan(name: string): LogicalPlanNode | null;
  cteResults: Map<string, MaterializedCTE>;
  cteDefinitions: Map<string, LogicalPlanNode>;
}

export async function buildCTEAnchor(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalCTEAnchorNode;
  const producer = await executor.buildPipeline(physical.children[0]);
  executor.cteDefinitions.set(node.cteName.toUpperCase(), node.children[0]);

  const consumer = await executor.buildPipeline(physical.children[1]);

  return {
    schema: consumer.schema,
    columnMapping: consumer.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const cteChunks: DataChunk[] = [];
      const cteSink: Sink = { consume: async (c: DataChunk) => { cteChunks.push(c); } };
      const producerPipelineId = graph.createPipeline(cteSink);
      producer.register(graph, producerPipelineId, cteSink);
      cteSink.finalize = async () => {
        executor.cteResults.set(node.cteName.toUpperCase(), { chunks: cteChunks, schema: producer.schema, columnMapping: producer.columnMapping });
      };

      graph.addDependency(currentPipelineId, producerPipelineId);
      consumer.register(graph, currentPipelineId, currentSink);
    }
  };
}

export async function buildCTEScan(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalCTEScanNode;
  const ctePlan = executor.findCTEPlan(node.cteName);
  if (!ctePlan) throw new Error(`CTE not found: ${node.cteName}`);

  const compiledCTE = await executor.buildLogicalPipeline(ctePlan);
  const schema: ExecSchema = compiledCTE.schema.map((col) => ({ ...col, tableAlias: node.alias }));

  return {
    schema,
    columnMapping: executor.buildSchemaMapping(schema, node.alias),
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const source: SourceGenerator = async function* () {
        let stored = executor.cteResults.get(node.cteName.toUpperCase());
        if (!stored) {
          const cteChunks: DataChunk[] = [];
          const cteSink: Sink = {
            async consume(c: DataChunk) { cteChunks.push(c); },
            async finalize() {}
          };
          const cteGraph = new PipelineGraph();
          const ctePipelineId = cteGraph.createPipeline(cteSink);
          compiledCTE.register(cteGraph, ctePipelineId, cteSink);
          const scheduler = new TaskScheduler();
          await scheduler.schedule(cteGraph);

          stored = {
            chunks: cteChunks,
            schema: compiledCTE.schema,
            columnMapping: compiledCTE.columnMapping,
          };
          executor.cteResults.set(node.cteName.toUpperCase(), stored);
        }

        const clonedChunks = stored.chunks.map((chunk: DataChunk) => {
          const cols = chunk.columns.map((col): Column => {
            const newCol = new Column(col.dataType, chunk.size);
            for (let i = 0; i < chunk.size; i++) {
              newCol.set(i, col.get(chunk.activeRowIndex(i)));
            }
            newCol.length = chunk.size;
            return newCol;
          });
          return new DataChunk(cols, chunk.size);
        });

        for (const chunk of clonedChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}

export async function buildMaterialize(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const child = await executor.buildPipeline(physical.children[0]);
  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      child.register(graph, currentPipelineId, currentSink);
    }
  };
}

export async function buildDependentJoin(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalDependentJoinNode;
  if ((node.correlatedColumns || []).length > 0) {
    throw new Error(`Correlated ${node.subqueryType} subquery reached execution without being decorrelated; SubqueryUnnesting is required for correctness`);
  }
  const outer = await executor.buildPipeline(physical.children[0]);
  const dummyOp = new DependentJoinOperator(node.subqueryType, outer.schema, node.markColumn);

  return {
    schema: dummyOp.resultSchema,
    columnMapping: executor.buildSchemaMapping(dummyOp.resultSchema, ''),
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const outerChunks: DataChunk[] = [];
      const outerSink: Sink = { consume: async (c: DataChunk) => { outerChunks.push(c); } };
      const outerPipelineId = graph.createPipeline(outerSink);
      outer.register(graph, outerPipelineId, outerSink);

      graph.addDependency(currentPipelineId, outerPipelineId);

      const source: SourceGenerator = async function* () {
        const runtimeOp = new DependentJoinOperator(node.subqueryType, outer.schema, node.markColumn);
        let innerChunks: DataChunk[] | null = null;

        for (const outerChunk of outerChunks) {
          for (const outerRow of outerChunk.toRows()) {
            if (innerChunks === null) {
              const innerPipeline = await executor.buildPipeline(physical.children[1]);
              const produced: DataChunk[] = [];
              const innerGraph = new PipelineGraph();
              const innerSink: Sink = { consume: async (c: DataChunk) => { produced.push(c); } };
              const innerPipelineId = innerGraph.createPipeline(innerSink);
              innerPipeline.register(innerGraph, innerPipelineId, innerSink);
              await new TaskScheduler(Config.dependentJoinConcurrency).schedule(innerGraph);
              innerChunks = produced;
            }
            await runtimeOp.processOuterRow(outerRow, innerChunks);
          }
        }

        const resultChunks = await runtimeOp.finalize();
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}
