export class QueryResult {
  constructor(columnNames, sink) {
    this._columnNames = columnNames;
    this._sink = sink;
  }

  get columns() {
    return this._columnNames;
  }

  async toArray() {
    const result = [];
    for await (const chunk of this._sink) {
      for (let i = 0; i < chunk.size; i++) {
        const rowIdx = chunk.activeRowIndex(i);
        const obj = {};
        for (let j = 0; j < this._columnNames.length; j++) {
          let val = chunk.columns[j].get(rowIdx);
          if (typeof val === 'bigint') val = Number(val);
          obj[this._columnNames[j]] = val;
        }
        result.push(obj);
      }
    }
    return result;
  }

  async *[Symbol.asyncIterator]() {
    for await (const chunk of this._sink) {
      for (let i = 0; i < chunk.size; i++) {
        const rowIdx = chunk.activeRowIndex(i);
        const obj = {};
        for (let j = 0; j < this._columnNames.length; j++) {
          let val = chunk.columns[j].get(rowIdx);
          if (typeof val === 'bigint') val = Number(val);
          obj[this._columnNames[j]] = val;
        }
        yield obj;
      }
    }
  }

  async *chunks() {
    for await (const chunk of this._sink) {
      yield chunk;
    }
  }
}
