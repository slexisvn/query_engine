import { Column } from './column.js';
import { DictionaryColumn } from './dictionary-column.js';
import { DataType } from './data-type.js';

export const DEFAULT_CHUNK_SIZE = 2048;

export class DataChunk {
  constructor(columns, size = 0) {
    this.columns = columns;
    this.size = size;
    this.selectionVector = null;
    this._cachedColumnCount = columns.length;
  }

  static fromSchema(schema, capacity = DEFAULT_CHUNK_SIZE) {
    const columns = schema.map(({ dataType }) => {
      if (dataType === DataType.VARCHAR) {
        return new DictionaryColumn(capacity);
      }
      return new Column(dataType, capacity);
    });
    return new DataChunk(columns, 0);
  }

  getColumn(index) {
    return this.columns[index];
  }

  columnCount() {
    return this.columns.length;
  }

  getValue(rowIndex, colIndex) {
    const actualRow = this.selectionVector ? this.selectionVector[rowIndex] : rowIndex;
    return this.columns[colIndex].get(actualRow);
  }

  activeRowIndex(i) {
    return this.selectionVector ? this.selectionVector[i] : i;
  }

  setSelectionVector(sv, count) {
    this.selectionVector = sv;
    this.size = count;
  }

  clearSelectionVector() {
    this.selectionVector = null;
  }

  appendRow(values) {
    const rowIdx = this.size;
    for (let i = 0; i < values.length; i++) {
      this.columns[i].set(rowIdx, values[i]);
    }
    this.size++;
  }

  project(indices) {
    const projectedColumns = indices.map(i => this.columns[i]);
    const chunk = new DataChunk(projectedColumns, this.size);
    chunk.selectionVector = this.selectionVector;
    return chunk;
  }

  flatten() {
    if (!this.selectionVector) return this;

    const newColumns = this.columns.map(col => {
      const newCol = new Column(col.dataType, this.size);
      for (let i = 0; i < this.size; i++) {
        newCol.set(i, col.get(this.selectionVector[i]));
      }
      newCol.length = this.size;
      return newCol;
    });

    return new DataChunk(newColumns, this.size);
  }

  reset() {
    this.size = 0;
    this.selectionVector = null;
    for (const col of this.columns) {
      col.length = 0;
    }
  }

  toRows() {
    const rows = [];
    for (let i = 0; i < this.size; i++) {
      const row = [];
      for (let j = 0; j < this.columns.length; j++) {
        row.push(this.getValue(i, j));
      }
      rows.push(row);
    }
    return rows;
  }
}
