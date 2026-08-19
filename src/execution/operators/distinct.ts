import { ChunkDeduplicator } from './chunk-deduplicator.js';
import type { DataChunk } from '../../storage/chunk.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';

export class DistinctOperator {
  deduplicator: ChunkDeduplicator;

  constructor(spillStore: ChunkSpillStore | null = null) {
    this.deduplicator = new ChunkDeduplicator(spillStore);
  }

  async init(): Promise<void> {}

  async process(chunk: DataChunk): Promise<DataChunk> {
    return this.deduplicator.filter(chunk);
  }

  async consume(chunk: DataChunk): Promise<void> {
    await this.deduplicator.buffer(await this.process(chunk));
  }

  finalize(): AsyncGenerator<DataChunk> {
    return this.deduplicator.drain();
  }
}
