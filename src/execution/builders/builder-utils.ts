import type { DataChunk } from '../../storage/chunk.js';
import type { PipelineGraph } from '../pipeline.js';
import type { ExecutionContext } from '../execution-context.js';
import type { ColumnMapping, CompiledPipeline, Sink, SourceGenerator } from '../execution-types.js';
import { AMBIGUOUS_COLUMN } from '../column-resolve.js';
import { SortOperator, type SortKey } from '../operators/sort.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';

type MappedInput = Pick<CompiledPipeline, 'schema' | 'columnMapping'>;

export function combinedMappingOf(...inputs: MappedInput[]): ColumnMapping {
  const mapping = new Map<string, number>();
  const bareOwner = new Map<string, number>();
  let base = 0;

  for (const [inputIndex, input] of inputs.entries()) {
    input.schema.forEach((col, i) => {
      mapping.set(`${col.tableAlias}.${col.name}`.toUpperCase(), base + i);
      const bare = col.name.toUpperCase();
      const owner = bareOwner.get(bare);
      if (owner === undefined) {
        bareOwner.set(bare, inputIndex);
        mapping.set(bare, base + i);
      } else if (owner !== inputIndex) {
        mapping.set(bare, AMBIGUOUS_COLUMN);
      }
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

export function scanSource(ctx: ExecutionContext, currentSink: Sink, chunks: () => AsyncIterable<DataChunk>): SourceGenerator {
  return async function* (): AsyncGenerator<DataChunk> {
    for await (const chunk of chunks()) {
      if (currentSink.cancelToken?.isCancelled) break;
      await currentSink.consume(chunk);
      yield chunk;
    }
    if (ctx.cancelToken.isCancelled) return;
    if (currentSink.finalize) await currentSink.finalize();
  };
}
