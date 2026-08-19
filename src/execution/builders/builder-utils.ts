import type { DataChunk } from '../../storage/chunk.js';
import type { PipelineGraph } from '../pipeline.js';
import type { ColumnMapping, CompiledPipeline, ExecSchema, Sink } from '../execution-types.js';
import { SortOperator, type SortKey } from '../operators/sort.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';

export function combinedMappingOf(...schemas: ExecSchema[]): ColumnMapping {
  const mapping = new Map<string, number>();
  let idx = 0;
  for (const schema of schemas) {
    for (const col of schema) {
      const key = `${col.tableAlias}.${col.name}`.toUpperCase();
      mapping.set(key, idx);
      if (!mapping.has(col.name.toUpperCase())) {
        mapping.set(col.name.toUpperCase(), idx);
      }
      idx++;
    }
  }
  return mapping;
}

export function registerBufferedChild(graph: PipelineGraph, currentPipelineId: number, compiled: CompiledPipeline): DataChunk[] {
  const chunks: DataChunk[] = [];
  const sink: Sink = {
    consume: async (chunk: DataChunk) => { chunks.push(chunk); },
    finalize: async () => {},
  };
  const pipelineId = graph.createPipeline(sink);
  compiled.register(graph, pipelineId, sink);
  graph.addDependency(currentPipelineId, pipelineId);
  return chunks;
}

export function registerSortedChild(
  graph: PipelineGraph,
  currentPipelineId: number,
  compiled: CompiledPipeline,
  sortKeys: SortKey[],
  spillStore: ChunkSpillStore,
): () => AsyncIterable<DataChunk> {
  const sortOp = new SortOperator(sortKeys, null, 0, spillStore);
  const sink: Sink = {
    consume: async (chunk: DataChunk) => { await sortOp.consume(chunk); },
    finalize: async () => {},
  };
  const pipelineId = graph.createPipeline(sink);
  compiled.register(graph, pipelineId, sink);
  graph.addDependency(currentPipelineId, pipelineId);
  return () => sortOp.stream();
}
