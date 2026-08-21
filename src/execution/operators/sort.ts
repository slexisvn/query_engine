import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';
import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { PriorityQueue } from '../../utils/priority-queue.js';
import { Config } from '../../config.js';
import { RowMemoryBudget } from '../memory-budget.js';
import type { ColumnValue, DataType } from '../../storage/data-type.js';
import type { CompiledExpr, EvalValue } from '../execution-types.js';

export interface SortKey {
  eval: CompiledExpr;
  direction: string;
  nullsFirst: boolean;
}

export function nullsFirstFor(direction?: string | null, nullOrder?: string | null): boolean {
  if (nullOrder) return nullOrder.toUpperCase() === 'FIRST';
  return (direction || 'ASC').toUpperCase() === 'DESC';
}

export function compareOrderedValues(a: EvalValue, b: EvalValue, direction: string | undefined, nullsFirst: boolean): number {
  const left = typeof a === 'bigint' ? Number(a) : (a ?? null);
  const right = typeof b === 'bigint' ? Number(b) : (b ?? null);
  if (left === null) return right === null ? 0 : (nullsFirst ? -1 : 1);
  if (right === null) return nullsFirst ? 1 : -1;
  const descending = (direction || 'ASC').toUpperCase() === 'DESC';
  if ((left as number) < (right as number)) return descending ? 1 : -1;
  if ((left as number) > (right as number)) return descending ? -1 : 1;
  return 0;
}

interface RunState {
  iter: AsyncGenerator<DataChunk>;
  chunk: DataChunk;
  keys: ColumnValue[][];
  index: number;
}

interface MergeCursor {
  runIndex: number;
  rowIndex: number;
}

export class SortOperator {
  keyExtractors: SortKey[];
  limit: number | null;
  offset: number;
  topN: number | null;
  columns: ColumnValue[][];
  keys: ColumnValue[][];
  rowCount: number;
  schema: DataType[] | null;
  spillManager: ChunkSpillStore;
  runCount: number;
  memoryBudget: RowMemoryBudget;

  constructor(keyExtractors: SortKey[], limit: number | null, offset: number, spillManager: ChunkSpillStore) {
    this.keyExtractors = keyExtractors;
    this.limit = limit ?? null;
    this.offset = offset || 0;
    this.topN = this.limit !== null ? this.limit + this.offset : null;
    this.columns = [];
    this.keys = keyExtractors.map(() => []);
    this.rowCount = 0;
    this.schema = null;

    this.spillManager = spillManager;
    this.runCount = 0;
    this.memoryBudget = new RowMemoryBudget();
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
    if (!this.schema) {
      this.schema = chunk.columns.map((c) => c.dataType);
      this.memoryBudget.adoptSchema(this.schema);
      this.columns = this.schema.map(() => []);
    }

    this.appendChunk(chunk);
    this.memoryBudget.admit(chunk.size);

    if (this.topN && this.runCount === 0 && this.rowCount > this.topN * 4) {
      this.retain(this.sortedIndices().subarray(0, this.topN));
      this.memoryBudget.reset();
      this.memoryBudget.admit(this.rowCount);
    }

    if (this.memoryBudget.exceeded) {
      await this.spillCurrentRun();
    }
  }

  appendChunk(chunk: DataChunk): void {
    const columnCount = this.columns.length;
    for (let i = 0; i < chunk.size; i++) {
      const rowIdx = chunk.activeRowIndex(i);
      for (let c = 0; c < columnCount; c++) {
        this.columns[c].push(chunk.columns[c]?.get(rowIdx) ?? null);
      }
      for (let k = 0; k < this.keyExtractors.length; k++) {
        this.keys[k].push(this.keyExtractors[k].eval(chunk, rowIdx) as ColumnValue);
      }
    }
    this.rowCount += chunk.size;
  }

  sortedIndices(): Uint32Array {
    const keyCount = this.keyExtractors.length;
    const order: number[] = new Array(this.rowCount);
    for (let i = 0; i < this.rowCount; i++) order[i] = i;

    if (keyCount === 1) {
      const key = this.keys[0];
      const { direction, nullsFirst } = this.keyExtractors[0];
      const radix = radixSortedIndices(key, this.rowCount, direction, nullsFirst);
      if (radix) return radix;
      order.sort((a, b) => compareOrderedValues(key[a], key[b], direction, nullsFirst) || a - b);
    } else {
      order.sort((a, b) => {
        for (let k = 0; k < keyCount; k++) {
          const key = this.keyExtractors[k];
          const cmp = compareOrderedValues(this.keys[k][a], this.keys[k][b], key.direction, key.nullsFirst);
          if (cmp !== 0) return cmp;
        }
        return a - b;
      });
    }

    return Uint32Array.from(order);
  }

  retain(indices: Uint32Array): void {
    this.columns = this.columns.map((column) => gather(column, indices));
    this.keys = this.keys.map((key) => gather(key, indices));
    this.rowCount = indices.length;
  }

  resetRows(): void {
    this.columns = this.columns.map(() => []);
    this.keys = this.keys.map(() => []);
    this.rowCount = 0;
  }

  async spillCurrentRun(): Promise<void> {
    if (this.rowCount === 0) return;
    let indices = this.sortedIndices();
    if (this.topN && indices.length > this.topN) indices = indices.subarray(0, this.topN);

    await this.spillManager.appendChunk(`run_${this.runCount}`, this.gatherChunk(indices, 0, indices.length));
    this.runCount++;
    this.resetRows();
    this.memoryBudget.reset();
  }

  async *stream(): AsyncGenerator<DataChunk> {
    if (this.runCount === 0) {
      let indices = this.sortedIndices();
      if (this.topN && indices.length > this.topN) indices = indices.subarray(0, this.topN);
      if (this.offset > 0) indices = indices.subarray(Math.min(this.offset, indices.length));

      await this.spillManager.clearAll();
      for (let start = 0; start < indices.length; start += Config.flushBatchSize) {
        yield this.gatherChunk(indices, start, Math.min(start + Config.flushBatchSize, indices.length));
      }
      return;
    }

    if (this.rowCount > 0) {
      await this.spillCurrentRun();
    }

    const states: RunState[] = new Array(this.runCount);
    const pq = new PriorityQueue<MergeCursor>((a, b) => {
      for (let k = 0; k < this.keyExtractors.length; k++) {
        const key = this.keyExtractors[k];
        const cmp = compareOrderedValues(
          states[a.runIndex].keys[k][a.rowIndex],
          states[b.runIndex].keys[k][b.rowIndex],
          key.direction,
          key.nullsFirst,
        );
        if (cmp !== 0) return cmp;
      }
      return a.runIndex - b.runIndex;
    });

    for (let i = 0; i < this.runCount; i++) {
      const iter = this.spillManager.readChunks(`run_${i}`);
      const next = await iter.next();
      if (next.done || next.value.size === 0) continue;
      states[i] = { iter, chunk: next.value, keys: this.chunkKeys(next.value), index: 1 };
      pq.push({ runIndex: i, rowIndex: 0 });
    }

    let pending: MergeCursor[] = [];
    let count = 0;
    let skipped = 0;

    while (!pq.isEmpty()) {
      if (this.topN && count >= this.topN) break;

      const cursor = pq.pop() as MergeCursor;
      count++;

      if (skipped < this.offset) {
        skipped++;
      } else {
        pending.push(cursor);
      }

      const state = states[cursor.runIndex];
      if (state.index < state.chunk.size) {
        pq.push({ runIndex: cursor.runIndex, rowIndex: state.index });
        state.index++;
      } else {
        const next = await state.iter.next();
        if (!next.done && next.value.size > 0) {
          if (pending.length > 0) {
            yield this.cursorsToChunk(pending, states);
            pending = [];
          }
          state.chunk = next.value;
          state.keys = this.chunkKeys(next.value);
          state.index = 1;
          pq.push({ runIndex: cursor.runIndex, rowIndex: 0 });
        }
      }

      if (pending.length >= Config.flushBatchSize) {
        yield this.cursorsToChunk(pending, states);
        pending = [];
      }
    }

    if (pending.length > 0) {
      yield this.cursorsToChunk(pending, states);
    }

    await this.spillManager.clearAll();
  }

  chunkKeys(chunk: DataChunk): ColumnValue[][] {
    return this.keyExtractors.map((key) => {
      const values: ColumnValue[] = new Array(chunk.size);
      for (let i = 0; i < chunk.size; i++) values[i] = key.eval(chunk, chunk.activeRowIndex(i)) as ColumnValue;
      return values;
    });
  }

  gatherChunk(indices: Uint32Array, from: number, to: number): DataChunk {
    const size = to - from;
    if (size <= 0) return new DataChunk([], 0);
    const columns: Column[] = this.columns.map((source, c) => {
      const column = new Column((this.schema?.[c] || 'VARCHAR') as DataType, size);
      for (let r = 0; r < size; r++) column.set(r, source[indices[from + r]]);
      column.length = size;
      return column;
    });
    return new DataChunk(columns, size);
  }

  cursorsToChunk(cursors: MergeCursor[], states: RunState[]): DataChunk {
    const size = cursors.length;
    const columnCount = this.schema?.length ?? 0;
    const columns: Column[] = new Array(columnCount);
    for (let c = 0; c < columnCount; c++) {
      const column = new Column((this.schema?.[c] || 'VARCHAR') as DataType, size);
      for (let r = 0; r < size; r++) {
        const cursor = cursors[r];
        const chunk = states[cursor.runIndex].chunk;
        column.set(r, chunk.columns[c]?.get(chunk.activeRowIndex(cursor.rowIndex)) ?? null);
      }
      column.length = size;
      columns[c] = column;
    }
    return new DataChunk(columns, size);
  }
}

const RADIX_BITS = 16;
const RADIX_BUCKETS = 1 << RADIX_BITS;
const RADIX_MASK = RADIX_BUCKETS - 1;
const INT32_BIAS = 2147483648;
const UINT32_MAX = 4294967295;

function radixSortedIndices(
  key: ColumnValue[],
  rowCount: number,
  direction: string | undefined,
  nullsFirst: boolean,
): Uint32Array | null {
  if (rowCount < Config.radixSortMinRows) return null;

  const ranks = new Uint32Array(rowCount);
  const present = new Uint32Array(rowCount);
  const nulls: number[] = [];
  const descending = (direction || 'ASC').toUpperCase() === 'DESC';
  let count = 0;

  for (let i = 0; i < rowCount; i++) {
    const value = key[i];
    if (value === null || value === undefined) {
      nulls.push(i);
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < -INT32_BIAS || value >= INT32_BIAS) return null;
    const biased = (value + INT32_BIAS) >>> 0;
    ranks[count] = descending ? (UINT32_MAX - biased) >>> 0 : biased;
    present[count] = i;
    count++;
  }

  const sorted = radixPermute(ranks.subarray(0, count), present.subarray(0, count));
  const result = new Uint32Array(rowCount);
  let at = 0;
  if (nullsFirst) for (const index of nulls) result[at++] = index;
  result.set(sorted, at);
  at += sorted.length;
  if (!nullsFirst) for (const index of nulls) result[at++] = index;
  return result;
}

function radixPermute(ranks: Uint32Array, indices: Uint32Array): Uint32Array {
  const count = indices.length;
  let currentRanks = Uint32Array.from(ranks);
  let currentIndices = Uint32Array.from(indices);
  let nextRanks = new Uint32Array(count);
  let nextIndices = new Uint32Array(count);
  const counts = new Uint32Array(RADIX_BUCKETS);

  for (let shift = 0; shift < 32; shift += RADIX_BITS) {
    counts.fill(0);
    for (let i = 0; i < count; i++) counts[(currentRanks[i] >>> shift) & RADIX_MASK]++;

    let total = 0;
    for (let bucket = 0; bucket < RADIX_BUCKETS; bucket++) {
      const bucketCount = counts[bucket];
      counts[bucket] = total;
      total += bucketCount;
    }

    for (let i = 0; i < count; i++) {
      const slot = counts[(currentRanks[i] >>> shift) & RADIX_MASK]++;
      nextRanks[slot] = currentRanks[i];
      nextIndices[slot] = currentIndices[i];
    }

    const swapRanks = currentRanks;
    currentRanks = nextRanks;
    nextRanks = swapRanks;
    const swapIndices = currentIndices;
    currentIndices = nextIndices;
    nextIndices = swapIndices;
  }

  return currentIndices;
}

function gather(source: ColumnValue[], indices: Uint32Array): ColumnValue[] {
  const result: ColumnValue[] = new Array(indices.length);
  for (let i = 0; i < indices.length; i++) result[i] = source[indices[i]];
  return result;
}

export class LimitOperator {
  limit: number;
  offset: number;
  seen: number;
  emitted: number;
  chunks: DataChunk[];
  schema: DataType[] | null;
  done: boolean;

  constructor(limit: number, offset: number = 0) {
    this.limit = limit;
    this.offset = offset;
    this.seen = 0;
    this.emitted = 0;
    this.chunks = [];
    this.schema = null;
    this.done = false;
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
    if (this.done) return;
    if (!this.schema) {
      this.schema = chunk.columns.map((c) => c.dataType);
    }

    const chunkStart = this.seen;
    const chunkEnd = this.seen + chunk.size;
    this.seen = chunkEnd;

    if (chunkEnd <= this.offset) return;

    const startInChunk = Math.max(0, this.offset - chunkStart);
    const remaining = this.limit - this.emitted;
    if (remaining <= 0) { this.done = true; return; }
    const endInChunk = Math.min(chunk.size, startInChunk + remaining);
    const count = endInChunk - startInChunk;
    if (count <= 0) return;

    if (startInChunk === 0 && count === chunk.size && !chunk.selectionVector) {
      this.chunks.push(chunk);
    } else {
      const sv = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        sv[i] = chunk.activeRowIndex(startInChunk + i);
      }
      const result = new DataChunk(chunk.columns, count);
      result.setSelectionVector(sv, count);
      this.chunks.push(result);
    }

    this.emitted += count;
    if (this.emitted >= this.limit) {
      this.done = true;
    }
  }

  async finalize(): Promise<DataChunk[]> {
    return this.takeChunks();
  }

  takeChunks(): DataChunk[] {
    if (this.chunks.length === 0) return [];
    const taken = this.chunks;
    this.chunks = [];
    return taken.map((c) => c.selectionVector ? c.flatten() : c);
  }
}
