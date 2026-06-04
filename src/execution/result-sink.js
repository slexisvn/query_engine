import { DataChunk } from '../storage/chunk.js';

export class ResultSink {
  constructor() {
    this.chunks = [];
    this._totalRows = 0;
  }

  async init() {}

  async consume(chunk) {
    if (chunk && chunk.size > 0) {
      this.chunks.push(chunk);
      this._totalRows += chunk.size;
    }
  }

  async finalize() {
    return this.chunks;
  }

  get totalRows() {
    return this._totalRows;
  }

  toRows() {
    const rows = [];
    for (const chunk of this.chunks) {
      const chunkRows = chunk.toRows();
      for (let i = 0; i < chunkRows.length; i++) {
        rows.push(chunkRows[i]);
      }
    }
    return rows;
  }

  toObjects(columnNames) {
    const rows = this.toRows();
    return rows.map(row => {
      const obj = {};
      for (let i = 0; i < columnNames.length; i++) {
        let val = row[i];
        if (typeof val === 'bigint') val = Number(val);
        obj[columnNames[i]] = val;
      }
      return obj;
    });
  }
}
