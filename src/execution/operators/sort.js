import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';

import { SpillManager } from '../../storage/spill-manager.js';
import { PriorityQueue } from '../../utils/priority-queue.js';

const MAX_ROWS_IN_RAM = parseInt(process.env.MAX_ROWS_IN_RAM || '200000');

export class SortOperator {
  constructor(keyExtractors, limit = null, offset = 0) {
    this.keyExtractors = keyExtractors; 
    this.limit = limit;
    this.offset = offset || 0;
    this.topN = limit !== null && limit !== undefined ? limit + this.offset : null;
    this.rows = [];
    this.schema = null;
    
    this.spillManager = new SpillManager();
    this.runCount = 0;
  }

  async init() {}

  async consume(chunk) {
    if (!this.schema) {
      this.schema = chunk.columns.map(c => c.dataType);
    }

    const chunkRows = new Array(chunk.size);
    for (let i = 0; i < chunk.size; i++) {
      const rowIdx = chunk.activeRowIndex(i);
      const row = new Array(chunk.columns.length);
      for (let c = 0; c < chunk.columns.length; c++) {
        row[c] = chunk.columns[c].get(rowIdx);
      }
      const sortKeys = new Array(this.keyExtractors.length);
      for (let k = 0; k < this.keyExtractors.length; k++) {
        sortKeys[k] = this.keyExtractors[k].eval(chunk, rowIdx);
      }
      chunkRows[i] = { row, sortKeys };
    }

    this.rows.push(...chunkRows);

    if (this.topN && this.runCount === 0 && this.rows.length > this.topN * 4) {
      this.rows.sort((a, b) => this.compareRows(a, b));
      this.rows.length = this.topN;
    }

    if (this.rows.length >= MAX_ROWS_IN_RAM) {
      await this.spillCurrentRun();
    }
  }

  async spillCurrentRun() {
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

  async finalize() {
    if (this.runCount === 0) {
      this.rows.sort((a, b) => this.compareRows(a, b));
      if (this.topN) {
        this.rows.length = Math.min(this.rows.length, this.topN);
      }
      if (this.rows.length === 0) return [];
      const chunk = this.rowsToChunk(this.rows);
      await this.spillManager.clearAll();
      return [chunk];
    }

    if (this.rows.length > 0) {
      await this.spillCurrentRun();
    }

    const iterators = [];
    for (let i = 0; i < this.runCount; i++) {
      iterators.push(this.spillManager.readChunks(`run_${i}`));
    }

    const pq = new PriorityQueue((a, b) => this.compareRows(a.item, b.item));
    const states = new Array(this.runCount);

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

    const resultChunks = [];
    let outRows = [];
    let count = 0;

    while (!pq.isEmpty()) {
      if (this.topN && count >= this.topN) break;

      const { item, runIndex } = pq.pop();
      outRows.push(item);
      count++;

      if (outRows.length >= 2048) {
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

  chunkToItems(chunk) {
    const items = new Array(chunk.size);
    for (let i = 0; i < chunk.size; i++) {
      const rowIdx = chunk.activeRowIndex(i);
      const row = new Array(chunk.columns.length);
      for (let c = 0; c < chunk.columns.length; c++) {
        row[c] = chunk.columns[c].get(rowIdx);
      }
      const sortKeys = new Array(this.keyExtractors.length);
      for (let k = 0; k < this.keyExtractors.length; k++) {
        sortKeys[k] = this.keyExtractors[k].eval(chunk, rowIdx);
      }
      items[i] = { row, sortKeys };
    }
    return items;
  }

  rowsToChunk(items) {
    if (items.length === 0) return new DataChunk([], 0);
    const colCount = items[0].row.length;
    const columns = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const col = new Column(this.schema?.[c] || 'VARCHAR', items.length);
      for (let r = 0; r < items.length; r++) {
        col.set(r, items[r].row[c]);
      }
      col.length = items.length;
      columns[c] = col;
    }
    return new DataChunk(columns, items.length);
  }

  compareRows(a, b) {
    for (let i = 0; i < this.keyExtractors.length; i++) {
      let v1 = a.sortKeys[i];
      let v2 = b.sortKeys[i];
      if (typeof v1 === 'bigint') v1 = Number(v1);
      if (typeof v2 === 'bigint') v2 = Number(v2);

      if (v1 === null && v2 !== null) return 1;
      if (v1 !== null && v2 === null) return -1;
      if (v1 === null && v2 === null) continue;

      if (v1 < v2) return this.keyExtractors[i].direction === 'ASC' ? -1 : 1;
      if (v1 > v2) return this.keyExtractors[i].direction === 'ASC' ? 1 : -1;
    }
    return 0;
  }
}

export class LimitOperator {
  constructor(limit, offset = 0) {
    this.limit = limit;
    this.offset = offset;
    this.seen = 0;
    this.emitted = 0;
    this.chunks = [];
    this.schema = null;
    this.done = false;
  }

  async init() {}

  async consume(chunk) {
    if (this.done) return;
    if (!this.schema) {
      this.schema = chunk.columns.map(c => c.dataType);
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

  async finalize() {
    if (this.chunks.length === 0) return [];

    return this.chunks.map(c => c.selectionVector ? c.flatten() : c);
  }
}
