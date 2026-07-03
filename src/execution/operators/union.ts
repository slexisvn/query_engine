import { DataChunk } from '../../storage/chunk.js';
import type { DataType } from '../../storage/data-type.js';
import { dedupProcess, dedupConsume, dedupFinalize, type DedupTarget } from './dedup-core.js';

export class UnionOperator {
  isAll: boolean;
  seen: Set<string> | null;
  schema: DataType[] | null;
  _legacyChunks!: DataChunk[];

  constructor(isAll: boolean) {
    this.isAll = isAll;
    this.seen = isAll ? null : new Set();
    this.schema = null;
  }

  async init(): Promise<void> {}

  async process(chunk: DataChunk): Promise<DataChunk> {
    if (this.isAll) return chunk;
    return dedupProcess(this as unknown as DedupTarget, chunk);
  }

  async consume(chunk: DataChunk): Promise<void> {
    await dedupConsume(this as unknown as DedupTarget, await this.process(chunk));
  }

  async finalize(): Promise<DataChunk[]> {
    return dedupFinalize(this as unknown as DedupTarget);
  }
}
