import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { Config } from '../../config.js';
import { keyIdentityText } from '../hash-table.js';
import { hashValue } from '../../utils/hash.js';
import { RowMemoryBudget } from '../memory-budget.js';
import { DataType, type ColumnValue } from '../../storage/data-type.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';

const EMITTED_HANDLE = 'dedup_emitted';
const KEY_PARTITION_PREFIX = 'dedup_keys_';
const ROW_PARTITION_PREFIX = 'dedup_rows_';

function keysToChunk(keys: string[]): DataChunk {
  const column = new Column(DataType.VARCHAR, keys.length);
  for (let i = 0; i < keys.length; i++) column.set(i, keys[i]);
  column.length = keys.length;
  return new DataChunk([column], keys.length);
}

export class ChunkDeduplicator {
  seen: Set<string>;
  schema: DataType[] | null;
  buffered: DataChunk[];
  keyParts: ColumnValue[];
  spillStore: ChunkSpillStore | null;
  partitionCount: number;
  memoryBudget: RowMemoryBudget;
  overflowed: boolean;
  spilledEmitted: boolean;

  constructor(spillStore: ChunkSpillStore | null = null) {
    this.seen = new Set();
    this.schema = null;
    this.buffered = [];
    this.keyParts = [];
    this.spillStore = spillStore;
    this.partitionCount = Config.dedupSpillPartitions;
    this.memoryBudget = new RowMemoryBudget();
    this.overflowed = false;
    this.spilledEmitted = false;
  }

  rowKey(chunk: DataChunk, rowIndex: number): string {
    if (this.keyParts.length !== chunk.columns.length) {
      this.keyParts = new Array(chunk.columns.length);
    }
    for (let c = 0; c < chunk.columns.length; c++) {
      this.keyParts[c] = chunk.columns[c].get(rowIndex);
    }
    return keyIdentityText(this.keyParts, this.keyParts.length);
  }

  adoptSchema(chunk: DataChunk): void {
    if (this.schema) return;
    this.schema = chunk.columns.map((c) => c.dataType);
    this.memoryBudget.adoptSchema(this.schema);
  }

  filterResident(chunk: DataChunk): DataChunk {
    const selection = new Uint32Array(chunk.size);
    let count = 0;

    for (let i = 0; i < chunk.size; i++) {
      const rowIndex = chunk.activeRowIndex(i);
      const key = this.rowKey(chunk, rowIndex);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      selection[count++] = rowIndex;
    }

    if (count === 0) return new DataChunk(chunk.columns, 0);
    if (count === chunk.size) return chunk;

    const result = new DataChunk(chunk.columns, count);
    result.setSelectionVector(selection.slice(0, count), count);
    return result;
  }

  async filter(chunk: DataChunk): Promise<DataChunk> {
    this.adoptSchema(chunk);

    if (this.overflowed) {
      await this.spillRows(chunk);
      return new DataChunk(chunk.columns, 0);
    }

    const result = this.filterResident(chunk);
    this.memoryBudget.admit(result.size);
    if (this.memoryBudget.exceeded) await this.overflow();
    return result;
  }

  async buffer(chunk: DataChunk): Promise<void> {
    if (chunk.size === 0) return;
    this.adoptSchema(chunk);
    const flat = chunk.selectionVector ? chunk.flatten() : chunk;

    if (this.overflowed && this.spillStore) {
      await this.spillStore.appendChunk(EMITTED_HANDLE, flat);
      this.spilledEmitted = true;
      return;
    }

    this.buffered.push(flat);
    this.memoryBudget.admit(flat.size);
    if (this.memoryBudget.exceeded) await this.overflow();
  }

  async overflow(): Promise<void> {
    const store = this.spillStore;
    if (!store || this.overflowed) return;

    for (const chunk of this.buffered) {
      await store.appendChunk(EMITTED_HANDLE, chunk);
      this.spilledEmitted = true;
    }
    this.buffered = [];

    const mask = this.partitionCount - 1;
    const keyPartitions: string[][] = Array.from({ length: this.partitionCount }, () => []);
    for (const key of this.seen) keyPartitions[hashValue(key) & mask].push(key);
    for (let p = 0; p < keyPartitions.length; p++) {
      if (keyPartitions[p].length === 0) continue;
      await store.appendChunk(KEY_PARTITION_PREFIX + p, keysToChunk(keyPartitions[p]));
    }
    this.seen.clear();

    this.overflowed = true;
    this.memoryBudget.reset();
  }

  async spillRows(chunk: DataChunk): Promise<void> {
    const store = this.spillStore;
    if (!store || chunk.size === 0) return;

    const mask = this.partitionCount - 1;
    const rowPartitions: number[][] = Array.from({ length: this.partitionCount }, () => []);
    for (let i = 0; i < chunk.size; i++) {
      const rowIndex = chunk.activeRowIndex(i);
      rowPartitions[hashValue(this.rowKey(chunk, rowIndex)) & mask].push(rowIndex);
    }

    for (let p = 0; p < rowPartitions.length; p++) {
      const rows = rowPartitions[p];
      if (rows.length === 0) continue;
      const partition = new DataChunk(chunk.columns, rows.length);
      partition.setSelectionVector(Uint32Array.from(rows), rows.length);
      await store.appendChunk(ROW_PARTITION_PREFIX + p, partition);
    }
  }

  async *drain(): AsyncGenerator<DataChunk> {
    const store = this.spillStore;

    if (store && this.spilledEmitted) {
      for await (const chunk of store.readChunks(EMITTED_HANDLE)) yield chunk;
    }
    for (const chunk of this.buffered) yield chunk;
    this.buffered = [];

    if (!store || !this.overflowed) return;

    for (let p = 0; p < this.partitionCount; p++) {
      this.seen.clear();
      for await (const keyChunk of store.readChunks(KEY_PARTITION_PREFIX + p)) {
        for (let i = 0; i < keyChunk.size; i++) {
          this.seen.add(keyChunk.columns[0].get(i) as string);
        }
      }
      for await (const rowChunk of store.readChunks(ROW_PARTITION_PREFIX + p)) {
        const deduped = this.filterResident(rowChunk);
        if (deduped.size > 0) yield deduped;
      }
    }

    this.seen.clear();
    await store.clearAll();
  }
}
