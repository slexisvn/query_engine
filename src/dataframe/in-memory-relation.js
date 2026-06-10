import { DataChunk, DEFAULT_CHUNK_SIZE } from '../storage/chunk.js';
import { inferColumnType, coerceForColumn } from './type-inference.js';

function buildChunks(schema, rowValues) {
  const chunks = [];
  let chunk = DataChunk.fromSchema(schema, DEFAULT_CHUNK_SIZE);
  for (const values of rowValues) {
    if (chunk.size >= DEFAULT_CHUNK_SIZE) {
      chunks.push(chunk);
      chunk = DataChunk.fromSchema(schema, DEFAULT_CHUNK_SIZE);
    }
    chunk.appendRow(values);
  }
  if (chunk.size > 0 || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

export class InMemoryRelation {
  constructor(schema, chunks) {
    this.schema = schema;
    this.chunks = chunks;
    this._rowCount = chunks.reduce((sum, c) => sum + c.size, 0);
  }

  getSchema() {
    return this.schema;
  }

  rowCount() {
    return this._rowCount;
  }

  getColumnIndex(name) {
    const upper = name.toUpperCase();
    return this.schema.findIndex(c => c.name.toUpperCase() === upper);
  }

  async *scan() {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  static fromRows(rows, declaredSchema = null) {
    const names = declaredSchema
      ? declaredSchema.map(c => c.name)
      : (rows.length > 0 ? Object.keys(rows[0]) : []);

    const extract = Array.isArray(rows[0])
      ? (row, i) => row[i]
      : (row, i) => row[names[i]];

    const columnValues = names.map((_, i) => rows.map(row => extract(row, i)));

    const schema = names.map((name, i) => ({
      name,
      dataType: declaredSchema ? declaredSchema[i].dataType : inferColumnType(columnValues[i]),
    }));

    const rowValues = rows.map(row =>
      schema.map((col, i) => coerceForColumn(extract(row, i), col.dataType)));

    return new InMemoryRelation(schema, buildChunks(schema, rowValues));
  }

  static fromColumns(columns, declaredSchema = null) {
    const names = Object.keys(columns);
    const length = names.length > 0 ? columns[names[0]].length : 0;

    const declaredByName = new Map((declaredSchema || []).map(c => [c.name, c.dataType]));
    const schema = names.map(name => ({
      name,
      dataType: declaredByName.has(name) ? declaredByName.get(name) : inferColumnType(columns[name]),
    }));

    const rowValues = [];
    for (let r = 0; r < length; r++) {
      rowValues.push(schema.map(col => coerceForColumn(columns[col.name][r], col.dataType)));
    }

    return new InMemoryRelation(schema, buildChunks(schema, rowValues));
  }
}
