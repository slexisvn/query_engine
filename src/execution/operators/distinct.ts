import { DataChunk } from '../../storage/chunk.js';
import type { DataType } from '../../storage/data-type.js';
import { dedupProcess, dedupConsume, dedupFinalize } from './dedup-core.js';

export class DistinctOperator {
  seen: Set<string>;
  schema: DataType[] | null;
  _legacyChunks!: DataChunk[];

  constructor() {
    this.seen = new Set();
    this.schema = null;
  }

  async init(): Promise<void> {}

  async process(chunk: DataChunk): Promise<DataChunk> {
    return dedupProcess(this, chunk);
  }

  async consume(chunk: DataChunk): Promise<void> {
    await dedupConsume(this, await this.process(chunk));
  }

  async finalize(): Promise<DataChunk[]> {
    return dedupFinalize(this);
  }
}
