import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import type { DataType } from '../../storage/data-type.js';

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
    if (!this.schema) {
      this.schema = chunk.columns.map((c) => c.dataType);
    }

    const sv = new Uint32Array(chunk.size);
    let count = 0;

    for (let i = 0; i < chunk.size; i++) {
      const rowIdx = chunk.activeRowIndex(i);
      let key = '';
      for (let c = 0; c < chunk.columns.length; c++) {
        if (c > 0) key += '|';
        key += String(chunk.columns[c].get(rowIdx));
      }

      if (!this.seen.has(key)) {
        this.seen.add(key);
        sv[count++] = rowIdx;
      }
    }

    if (count === 0) return new DataChunk(chunk.columns, 0);
    if (count === chunk.size) return chunk;

    const result = new DataChunk(chunk.columns, count);
    result.setSelectionVector(sv.slice(0, count), count);
    return result;
  }

  async consume(chunk: DataChunk): Promise<void> {
    if (!this._legacyChunks) this._legacyChunks = [];
    const result = await this.process(chunk);
    if (result.size > 0) {
      this._legacyChunks.push(result.selectionVector ? result.flatten() : result);
    }
  }

  async finalize(): Promise<DataChunk[]> {
    return this._legacyChunks || [];
  }
}
