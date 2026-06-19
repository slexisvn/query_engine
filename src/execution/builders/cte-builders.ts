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
  LogicalMaterializeNode,
  LogicalDependentJoinNode,
} from '../../planner/logical-plan.js';

interface CTEResult {
  chunks: DataChunk[];
  schema: ExecSchema;
  columnMapping: ColumnMapping;
}

interface ExecutorLike {
  buildPipeline(node: LogicalPlanNode): Promise<CompiledPipeline>;
  buildSchemaMapping(schema: ExecSchema, alias: string): ColumnMapping;
  findCTEPlan(name: string): LogicalPlanNode | null;
  cteResults: Map<string, CTEResult>;
  cteDefinitions: Map<string, LogicalPlanNode>;
}

export async function buildCTEAnchor(executor: ExecutorLike, node: LogicalCTEAnchorNode): Promise<CompiledPipeline> {
  const producer = await executor.buildPipeline(node.children[0]);
  executor.cteDefinitions.set(node.cteName.toUpperCase(), node.children[0]);

  const consumer = await executor.buildPipeline(node.children[1]);

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

export async function buildCTEScan(executor: ExecutorLike, node: LogicalCTEScanNode): Promise<CompiledPipeline> {
  const ctePlan = executor.findCTEPlan(node.cteName);
  if (!ctePlan) throw new Error(`CTE not found: ${node.cteName}`);

  const compiledCTE = await executor.buildPipeline(ctePlan);

  return {
    schema: compiledCTE.schema,
    columnMapping: compiledCTE.columnMapping,
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
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}

export async function buildMaterialize(executor: ExecutorLike, node: LogicalMaterializeNode): Promise<CompiledPipeline> {
  const child = await executor.buildPipeline(node.children[0]);
  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      child.register(graph, currentPipelineId, currentSink);
    }
  };
}

export async function buildDependentJoin(executor: ExecutorLike, node: LogicalDependentJoinNode): Promise<CompiledPipeline> {
  const outer = await executor.buildPipeline(node.children[0]);
  const dummyOp = new DependentJoinOperator(node.subqueryType, outer.schema);

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
        const runtimeOp = new DependentJoinOperator(node.subqueryType, outer.schema);
        const isCorrelated = (node.correlatedColumns || []).length > 0;
        let cachedInnerChunks: DataChunk[] | null = null;

        for (const outerChunk of outerChunks) {
          const outerRows = outerChunk.toRows();
          for (const outerRow of outerRows) {
            if (!isCorrelated && cachedInnerChunks !== null) {
              await runtimeOp.processOuterRow(outerRow, cachedInnerChunks);
              continue;
            }
            const innerPipeline = await executor.buildPipeline(node.children[1]);
            const innerChunks: DataChunk[] = [];
            const innerGraph = new PipelineGraph();
            const innerSink: Sink = { consume: async (c: DataChunk) => { innerChunks.push(c); } };
            const innerPipelineId = innerGraph.createPipeline(innerSink);
            innerPipeline.register(innerGraph, innerPipelineId, innerSink);
            await new TaskScheduler(Config.dependentJoinConcurrency).schedule(innerGraph);
            if (!isCorrelated) cachedInnerChunks = innerChunks;
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
