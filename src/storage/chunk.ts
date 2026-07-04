import { Column } from './column.js';
import { DictionaryColumn } from './dictionary-column.js';
import { DataType, type ColumnValue } from './data-type.js';

import { DEFAULT_CHUNK_SIZE } from '../config.js';

export type AnyColumn = Column | DictionaryColumn;
export type SelectionVector = Uint32Array | Int32Array | number[];

export class DataChunk {
  columns: AnyColumn[];
  size: number;
  selectionVector: SelectionVector | null;
  _cachedColumnCount: number;

  constructor(columns: AnyColumn[], size = 0) {
    this.columns = columns;
    this.size = size;
    this.selectionVector = null;
    this._cachedColumnCount = columns.length;
  }

  static fromSchema(schema: ReadonlyArray<{ dataType: DataType }>, capacity: number = DEFAULT_CHUNK_SIZE): DataChunk {
    const columns: AnyColumn[] = schema.map(({ dataType }) => {
      if (dataType === DataType.VARCHAR) {
        return new DictionaryColumn(capacity);
      }
      return new Column(dataType, capacity);
    });
    return new DataChunk(columns, 0);
  }

  getColumn(index: number): AnyColumn {
    return this.columns[index];
  }

  columnCount(): number {
    return this.columns.length;
  }

  getValue(rowIndex: number, colIndex: number): ColumnValue {
    const actualRow = this.selectionVector ? this.selectionVector[rowIndex] : rowIndex;
    return this.columns[colIndex].get(actualRow);
  }

  activeRowIndex(i: number): number {
    return this.selectionVector ? this.selectionVector[i] : i;
  }

  setSelectionVector(sv: SelectionVector | null, count: number): void {
    this.selectionVector = sv;
    this.size = count;
  }

  clearSelectionVector(): void {
    this.selectionVector = null;
  }

  appendRow(values: ColumnValue[]): void {
    const rowIdx = this.size;
    for (let i = 0; i < values.length; i++) {
      this.columns[i].set(rowIdx, values[i]);
    }
    this.size++;
  }

  project(indices: number[]): DataChunk {
    const projectedColumns = indices.map(i => this.columns[i]);
    const chunk = new DataChunk(projectedColumns, this.size);
    chunk.selectionVector = this.selectionVector;
    return chunk;
  }

  flatten(): DataChunk {
    if (!this.selectionVector) return this;

    const newColumns = this.columns.map(col => {
      const newCol = new Column(col.dataType, this.size);
      for (let i = 0; i < this.size; i++) {
        newCol.set(i, col.get(this.selectionVector![i]));
      }
      newCol.length = this.size;
      return newCol;
    });

    return new DataChunk(newColumns, this.size);
  }

  reset(): void {
    this.size = 0;
    this.selectionVector = null;
    for (const col of this.columns) {
      col.length = 0;
    }
  }

  toRows(): ColumnValue[][] {
    const rows: ColumnValue[][] = [];
    for (let i = 0; i < this.size; i++) {
      const row: ColumnValue[] = [];
      for (let j = 0; j < this.columns.length; j++) {
        row.push(this.getValue(i, j));
      }
      rows.push(row);
    }
    return rows;
  }
}
