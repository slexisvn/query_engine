import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { PriorityQueue } from '../../utils/priority-queue.js';
import { Config } from '../../config.js';
import type { ColumnValue, DataType } from '../../storage/data-type.js';
import type { CompiledExpr } from '../execution-types.js';
import { materializeActiveRow } from './join-core.js';

interface SortKey {
  eval: CompiledExpr;
  direction: string;
}

interface SortRow {
  row: ColumnValue[];
  sortKeys: ColumnValue[];
}

interface MergeState {
  iter: AsyncGenerator<DataChunk>;
  chunk: DataChunk;
  index: number;
  chunkItems: SortRow[];
}

interface SpillManagerLike {
  appendChunk(id: string, chunk: DataChunk | null): Promise<void>;
  readChunks(id: string): AsyncGenerator<DataChunk>;
  clearAll(): Promise<void>;
}

export class SortOperator {
  keyExtractors: SortKey[];
  limit: number | null;
  offset: number;
  topN: number | null;
  rows: SortRow[];
  schema: DataType[] | null;
  spillManager: SpillManagerLike;
  runCount: number;

  constructor(keyExtractors: SortKey[], limit: number | null, offset: number, spillManager: SpillManagerLike) {
    this.keyExtractors = keyExtractors;
    this.limit = limit ?? null;
    this.offset = offset || 0;
    this.topN = this.limit !== null ? this.limit + this.offset : null;
    this.rows = [];
    this.schema = null;

    this.spillManager = spillManager;
    this.runCount = 0;
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
    if (!this.schema) {
      this.schema = chunk.columns.map((c) => c.dataType);
    }

    const chunkRows: SortRow[] = new Array(chunk.size);
    for (let i = 0; i < chunk.size; i++) {
      const rowIdx = chunk.activeRowIndex(i);
      const row = materializeActiveRow(chunk, i);
      const sortKeys: ColumnValue[] = new Array(this.keyExtractors.length);
      for (let k = 0; k < this.keyExtractors.length; k++) {
        sortKeys[k] = this.keyExtractors[k].eval(chunk, rowIdx) as ColumnValue;
      }
      chunkRows[i] = { row, sortKeys };
    }

    this.rows.push(...chunkRows);

    if (this.topN && this.runCount === 0 && this.rows.length > this.topN * 4) {
      this.rows.sort((a, b) => this.compareRows(a, b));
      this.rows.length = this.topN;
    }

    if (this.rows.length >= Config.memoryLimit) {
      await this.spillCurrentRun();
    }
  }

  async spillCurrentRun(): Promise<void> {
    if (this.rows.length === 0) return;
    this.rows.sort((a, b) => this.compareRows(a, b));

    if (this.topN) {
      this.rows.length = Math.min(this.rows.length, this.topN);
    }

    const chunk = this.rowsToChunk(this.rows);
    await this.spillManager.appendChunk(`run_${this.runCount}`, chunk);
    this.runCount++;
    this.rows = [];
  }

  async finalize(): Promise<DataChunk[]> {
    if (this.runCount === 0) {
      this.rows.sort((a, b) => this.compareRows(a, b));
      if (this.topN) {
        this.rows.length = Math.min(this.rows.length, this.topN);
      }
      if (this.offset > 0) {
        this.rows = this.rows.slice(this.offset);
      }
      if (this.rows.length === 0) return [];
      const chunk = this.rowsToChunk(this.rows);
      await this.spillManager.clearAll();
      return [chunk];
    }

    if (this.rows.length > 0) {
      await this.spillCurrentRun();
    }

    const iterators: AsyncGenerator<DataChunk>[] = [];
    for (let i = 0; i < this.runCount; i++) {
      iterators.push(this.spillManager.readChunks(`run_${i}`));
    }

    const pq = new PriorityQueue<{ item: SortRow; runIndex: number }>((a, b) => this.compareRows(a.item, b.item));
    const states: MergeState[] = new Array(this.runCount);

    for (let i = 0; i < this.runCount; i++) {
      const iter = iterators[i];
      const next = await iter.next();
      if (!next.done && next.value.size > 0) {
        states[i] = {
          iter,
          chunk: next.value,
          index: 0,
          chunkItems: this.chunkToItems(next.value)
        };
        pq.push({ item: states[i].chunkItems[0], runIndex: i });
        states[i].index = 1;
      }
    }

    const resultChunks: DataChunk[] = [];
    let outRows: SortRow[] = [];
    let count = 0;
    let skipped = 0;

    while (!pq.isEmpty()) {
      if (this.topN && count >= this.topN) break;

      const { item, runIndex } = pq.pop() as { item: SortRow; runIndex: number };
      count++;

      if (skipped < this.offset) {
        skipped++;
      } else {
        outRows.push(item);
      }

      if (outRows.length >= Config.flushBatchSize) {
        resultChunks.push(this.rowsToChunk(outRows));
        outRows = [];
      }

      const state = states[runIndex];
      if (state.index < state.chunkItems.length) {
        pq.push({ item: state.chunkItems[state.index], runIndex });
        state.index++;
      } else {
        const next = await state.iter.next();
        if (!next.done && next.value.size > 0) {
          state.chunk = next.value;
          state.index = 0;
          state.chunkItems = this.chunkToItems(state.chunk);
          pq.push({ item: state.chunkItems[state.index], runIndex });
          state.index++;
        }
      }
    }

    if (outRows.length > 0) {
      resultChunks.push(this.rowsToChunk(outRows));
    }

    await this.spillManager.clearAll();
    return resultChunks;
  }

  chunkToItems(chunk: DataChunk): SortRow[] {
    const items: SortRow[] = new Array(chunk.size);
    for (let i = 0; i < chunk.size; i++) {
      const rowIdx = chunk.activeRowIndex(i);
      const row = materializeActiveRow(chunk, i);
      const sortKeys: ColumnValue[] = new Array(this.keyExtractors.length);
      for (let k = 0; k < this.keyExtractors.length; k++) {
        sortKeys[k] = this.keyExtractors[k].eval(chunk, rowIdx) as ColumnValue;
      }
      items[i] = { row, sortKeys };
    }
    return items;
  }

  rowsToChunk(items: SortRow[]): DataChunk {
    if (items.length === 0) return new DataChunk([], 0);
    const colCount = items[0].row.length;
    const columns: Column[] = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const col = new Column((this.schema?.[c] || 'VARCHAR') as DataType, items.length);
      for (let r = 0; r < items.length; r++) {
        col.set(r, items[r].row[c]);
      }
      col.length = items.length;
      columns[c] = col;
    }
    return new DataChunk(columns, items.length);
  }

  compareRows(a: SortRow, b: SortRow): number {
    for (let i = 0; i < this.keyExtractors.length; i++) {
      let v1 = a.sortKeys[i];
      let v2 = b.sortKeys[i];
      if (typeof v1 === 'bigint') v1 = Number(v1);
      if (typeof v2 === 'bigint') v2 = Number(v2);

      if (v1 === null && v2 !== null) return 1;
      if (v1 !== null && v2 === null) return -1;
      if (v1 === null && v2 === null) continue;

      if ((v1 as number) < (v2 as number)) return this.keyExtractors[i].direction === 'ASC' ? -1 : 1;
      if ((v1 as number) > (v2 as number)) return this.keyExtractors[i].direction === 'ASC' ? 1 : -1;
    }
    return 0;
  }
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
    if (this.chunks.length === 0) return [];

    return this.chunks.map((c) => c.selectionVector ? c.flatten() : c);
  }
}
