import type { DataChunk } from '../../storage/chunk.js';
import type { PipelineGraph } from '../pipeline.js';
import type { ColumnMapping, CompiledPipeline, Sink } from '../execution-types.js';
import { SortOperator, type SortKey } from '../operators/sort.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';

type MappedInput = Pick<CompiledPipeline, 'schema' | 'columnMapping'>;

export function combinedMappingOf(...inputs: MappedInput[]): ColumnMapping {
  const mapping = new Map<string, number>();
  let base = 0;
  for (const input of inputs) {
    input.schema.forEach((col, i) => {
      mapping.set(`${col.tableAlias}.${col.name}`.toUpperCase(), base + i);
      const bare = col.name.toUpperCase();
      if (!mapping.has(bare)) mapping.set(bare, base + i);
    });
    for (const [key, index] of input.columnMapping) {
      if (!mapping.has(key)) mapping.set(key, base + index);
    }
    base += input.schema.length;
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
