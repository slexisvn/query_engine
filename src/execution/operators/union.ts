import { ChunkDeduplicator } from './chunk-deduplicator.js';
import type { DataChunk } from '../../storage/chunk.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';

export class UnionOperator {
  isAll: boolean;
  deduplicator: ChunkDeduplicator;

  constructor(isAll: boolean, spillStore: ChunkSpillStore | null = null) {
    this.isAll = isAll;
    this.deduplicator = new ChunkDeduplicator(spillStore);
  }

  async init(): Promise<void> {}

  async process(chunk: DataChunk): Promise<DataChunk> {
    return this.isAll ? chunk : this.deduplicator.filter(chunk);
  }

  async consume(chunk: DataChunk): Promise<void> {
    await this.deduplicator.buffer(await this.process(chunk));
  }

  finalize(): AsyncGenerator<DataChunk> {
    return this.deduplicator.drain();
  }
}
