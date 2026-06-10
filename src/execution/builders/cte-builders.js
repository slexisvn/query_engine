import { DependentJoinOperator } from '../operators/dependent-join.js';
import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { PipelineGraph } from '../pipeline.js';
import { TaskScheduler } from '../scheduler.js';
import { Config } from '../../config.js';

export async function buildCTEAnchor(executor, node) {
  const producer = await executor.buildPipeline(node.children[0]);
  executor.cteDefinitions.set(node.cteName.toUpperCase(), node.children[0]);

  const consumer = await executor.buildPipeline(node.children[1]);

  return {
    schema: consumer.schema,
    columnMapping: consumer.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const cteChunks = [];
      const cteSink = { consume: async (c) => cteChunks.push(c) };
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

export async function buildCTEScan(executor, node) {
  const ctePlan = executor.findCTEPlan(node.cteName);
  if (!ctePlan) throw new Error(`CTE not found: ${node.cteName}`);

  const compiledCTE = await executor.buildPipeline(ctePlan);

  return {
    schema: compiledCTE.schema,
    columnMapping: compiledCTE.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      graph.setSource(currentPipelineId, async function* () {
        let stored = executor.cteResults.get(node.cteName.toUpperCase());
        if (!stored) {
          const cteChunks = [];
          const cteSink = {
            async consume(c) { cteChunks.push(c); },
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

        const clonedChunks = stored.chunks.map(chunk => {
          const cols = chunk.columns.map(col => {
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
      });
    }
  };
}

export async function buildMaterialize(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);
  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      child.register(graph, currentPipelineId, currentSink);
    }
  };
}

export async function buildDependentJoin(executor, node) {
  const outer = await executor.buildPipeline(node.children[0]);
  const dummyOp = new DependentJoinOperator(node.subqueryType, outer.schema);

  return {
    schema: dummyOp.resultSchema,
    columnMapping: executor.buildSchemaMapping(dummyOp.resultSchema, ''),
    register: (graph, currentPipelineId, currentSink) => {
      const outerChunks = [];
      const outerSink = { consume: async (c) => outerChunks.push(c) };
      const outerPipelineId = graph.createPipeline(outerSink);
      outer.register(graph, outerPipelineId, outerSink);

      graph.addDependency(currentPipelineId, outerPipelineId);

      graph.setSource(currentPipelineId, async function* () {
        const runtimeOp = new DependentJoinOperator(node.subqueryType, outer.schema);
        const isCorrelated = (node.correlatedColumns || []).length > 0;
        let cachedInnerChunks = null;

        for (const outerChunk of outerChunks) {
          const outerRows = outerChunk.toRows();
          for (const outerRow of outerRows) {
            if (!isCorrelated && cachedInnerChunks !== null) {
              await runtimeOp.processOuterRow(outerRow, cachedInnerChunks);
              continue;
            }
            const innerPipeline = await executor.buildPipeline(node.children[1]);
            const innerChunks = [];
            const innerGraph = new PipelineGraph();
            const innerSink = { consume: async (c) => innerChunks.push(c) };
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
      });
    }
  };
}
