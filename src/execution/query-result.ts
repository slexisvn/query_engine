export class QueryResult {
  _columnNames: string[];
  _sink: any;

  constructor(columnNames: string[], sink: any) {
    this._columnNames = columnNames;
    this._sink = sink;
  }

  get columns(): string[] {
    return this._columnNames;
  }

  async toArray(): Promise<any[]> {
    const result = [];
    for await (const chunk of this._sink) {
      for (let i = 0; i < chunk.size; i++) {
        const rowIdx = chunk.activeRowIndex(i);
        const obj: any = {};
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

  async *[Symbol.asyncIterator](): AsyncGenerator<any> {
    for await (const chunk of this._sink) {
      for (let i = 0; i < chunk.size; i++) {
        const rowIdx = chunk.activeRowIndex(i);
        const obj: any = {};
        for (let j = 0; j < this._columnNames.length; j++) {
          let val = chunk.columns[j].get(rowIdx);
          if (typeof val === 'bigint') val = Number(val);
          obj[this._columnNames[j]] = val;
        }
        yield obj;
      }
    }
  }

  async *chunks(): AsyncGenerator<any> {
    for await (const chunk of this._sink) {
      yield chunk;
    }
  }
}
