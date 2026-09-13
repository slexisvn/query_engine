import type { DataChunk } from '../storage/chunk.js';
import type { ColumnValue } from '../storage/data-type.js';

export type ResultRow = Record<string, ColumnValue>;

export interface AsyncChunkSource {
  [Symbol.asyncIterator](): AsyncIterator<DataChunk>;
}

function uniqueNames(columnNames: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return columnNames.map(name => {
    const taken = seen.get(name);
    if (taken === undefined) {
      seen.set(name, 1);
      return name;
    }
    seen.set(name, taken + 1);
    return `${name}_${taken + 1}`;
  });
}

export class QueryResult {
  _columnNames: string[];
  _sink: AsyncChunkSource;
  _rowKeys: string[];
  _onDone: ((abandoned: boolean) => void) | null;

  constructor(columnNames: string[], sink: AsyncChunkSource, onDone: ((abandoned: boolean) => void) | null = null) {
    this._columnNames = columnNames;
    this._sink = sink;
    this._rowKeys = uniqueNames(columnNames);
    this._onDone = onDone;
  }

  get columns(): string[] {
    return this._columnNames;
  }

  /** Keys the materialised row objects are indexed by: `columns`, with duplicates suffixed. */
  get rowKeys(): string[] {
    return this._rowKeys;
  }

  async toArray(): Promise<ResultRow[]> {
    const result: ResultRow[] = [];
    let completed = false;
    try {
      for await (const chunk of this._sink) {
        for (let i = 0; i < chunk.size; i++) {
          const rowIdx = chunk.activeRowIndex(i);
          const obj: ResultRow = {};
          for (let j = 0; j < this._columnNames.length; j++) {
            let val = chunk.columns[j].get(rowIdx);
            if (typeof val === 'bigint') val = Number(val);
            obj[this._rowKeys[j]] = val;
          }
          result.push(obj);
        }
      }
      completed = true;
      return result;
    } finally {
      this.finish(!completed);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ResultRow> {
    let completed = false;
    try {
      for await (const chunk of this._sink) {
        for (let i = 0; i < chunk.size; i++) {
          const rowIdx = chunk.activeRowIndex(i);
          const obj: ResultRow = {};
          for (let j = 0; j < this._columnNames.length; j++) {
            let val = chunk.columns[j].get(rowIdx);
            if (typeof val === 'bigint') val = Number(val);
            obj[this._rowKeys[j]] = val;
          }
          yield obj;
        }
      }
      completed = true;
    } finally {
      this.finish(!completed);
    }
  }

  async *chunks(): AsyncGenerator<DataChunk> {
    let completed = false;
    try {
      for await (const chunk of this._sink) {
        yield chunk;
      }
      completed = true;
    } finally {
      this.finish(!completed);
    }
  }

  finish(abandoned: boolean = false): void {
    const onDone = this._onDone;
    this._onDone = null;
    onDone?.(abandoned);
  }
}
