import { DataChunk } from '../storage/chunk.js';
import { DEFAULT_CHUNK_SIZE } from '../config.js';
import { inferColumnType, coerceForColumn } from './type-inference.js';
import { buildChunkZoneMap, type ChunkPruner, type ChunkZoneMap } from '../storage/zone-map.js';
import type { ColumnSchema, ColumnValue, DataType } from '../storage/data-type.js';

type RowInput = Record<string, ColumnValue> | ColumnValue[];
type ColumnsInput = Record<string, ColumnValue[]>;
type ExtractFn = (row: RowInput, i: number) => ColumnValue;

function buildChunks(schema: ColumnSchema[], rowValues: ColumnValue[][]): DataChunk[] {
  const chunks: DataChunk[] = [];
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
  schema: ColumnSchema[];
  chunks: DataChunk[];
  _rowCount: number;
  _zoneMaps: ChunkZoneMap[] | null;

  constructor(schema: ColumnSchema[], chunks: DataChunk[]) {
    this.schema = schema;
    this.chunks = chunks;
    this._rowCount = chunks.reduce((sum, c) => sum + c.size, 0);
    this._zoneMaps = null;
  }

  zoneMaps(): ChunkZoneMap[] {
    if (this._zoneMaps === null) {
      this._zoneMaps = this.chunks.map(buildChunkZoneMap);
    }
    return this._zoneMaps;
  }

  getSchema(): ColumnSchema[] {
    return this.schema;
  }

  rowCount(): number {
    return this._rowCount;
  }

  getColumnIndex(name: string): number {
    const upper = name.toUpperCase();
    return this.schema.findIndex(c => c.name.toUpperCase() === upper);
  }

  async *scan(pruner: ChunkPruner | null = null): AsyncGenerator<DataChunk, void, void> {
    if (!pruner) {
      yield* this.chunks;
      return;
    }
    const zoneMaps = this.zoneMaps();
    for (let i = 0; i < this.chunks.length; i++) {
      if (pruner.canSkip(zoneMaps[i])) continue;
      yield this.chunks[i];
    }
  }

  async scanAll(): Promise<DataChunk[]> {
    return this.chunks;
  }

  static fromRows(rows: RowInput[], declaredSchema: ColumnSchema[] | null = null): InMemoryRelation {
    const names = declaredSchema
      ? declaredSchema.map(c => c.name)
      : (rows.length > 0 ? Object.keys(rows[0]) : []);

    const extract: ExtractFn = Array.isArray(rows[0])
      ? (row, i) => (row as ColumnValue[])[i]
      : (row, i) => (row as Record<string, ColumnValue>)[names[i]];

    const columnValues = names.map((_, i) => rows.map(row => extract(row, i)));

    const schema: ColumnSchema[] = names.map((name, i) => ({
      name,
      dataType: declaredSchema ? declaredSchema[i].dataType : inferColumnType(columnValues[i]),
    }));

    const rowValues = rows.map(row =>
      schema.map((col, i) => coerceForColumn(extract(row, i), col.dataType)));

    return new InMemoryRelation(schema, buildChunks(schema, rowValues));
  }

  static fromColumns(columns: ColumnsInput, declaredSchema: ColumnSchema[] | null = null): InMemoryRelation {
    const names = Object.keys(columns);
    const length = names.length > 0 ? columns[names[0]].length : 0;

    const declaredByName = new Map<string, DataType>((declaredSchema || []).map(c => [c.name, c.dataType]));
    const schema: ColumnSchema[] = names.map(name => ({
      name,
      dataType: declaredByName.has(name) ? (declaredByName.get(name) as DataType) : inferColumnType(columns[name]),
    }));

    const rowValues: ColumnValue[][] = [];
    for (let r = 0; r < length; r++) {
      rowValues.push(schema.map(col => coerceForColumn(columns[col.name][r], col.dataType)));
    }

    return new InMemoryRelation(schema, buildChunks(schema, rowValues));
  }

  static builder(declaredSchema: ColumnSchema[] | null = null): RelationBuilder {
    return new RelationBuilder(declaredSchema);
  }
}

export class RelationBuilder {
  _declaredSchema: ColumnSchema[] | null;
  schema: ColumnSchema[] | null;
  _names: string[] | null;
  _extractByIndex: boolean;
  _chunks: DataChunk[];
  _chunk: DataChunk | null;
  _finished: boolean;

  constructor(declaredSchema: ColumnSchema[] | null = null) {
    this._declaredSchema = declaredSchema;
    this.schema = null;
    this._names = null;
    this._extractByIndex = false;
    this._chunks = [];
    this._chunk = null;
    this._finished = false;
  }

  _initFrom(rows: RowInput[]): void {
    const declaredSchema = this._declaredSchema;
    this._names = declaredSchema
      ? declaredSchema.map(c => c.name)
      : (rows.length > 0 ? Object.keys(rows[0]) : []);
    this._extractByIndex = Array.isArray(rows[0]);

    if (declaredSchema) {
      this.schema = declaredSchema.map(c => ({ name: c.name, dataType: c.dataType }));
    } else {
      const extract: ExtractFn = this._extractByIndex
        ? (row, i) => (row as ColumnValue[])[i]
        : (row, i) => (row as Record<string, ColumnValue>)[(this._names as string[])[i]];
      this.schema = this._names.map((name, i) => ({
        name,
        dataType: inferColumnType(rows.map(row => extract(row, i))),
      }));
    }
    this._chunk = DataChunk.fromSchema(this.schema, DEFAULT_CHUNK_SIZE);
  }

  appendRows(rows: RowInput[]): this {
    if (this._finished) throw new Error('RelationBuilder: appendRows after finish()');
    if (!rows || rows.length === 0) return this;
    if (this.schema === null) this._initFrom(rows);

    const schema = this.schema as ColumnSchema[];
    const names = this._names as string[];
    const extract: ExtractFn = this._extractByIndex
      ? (row, i) => (row as ColumnValue[])[i]
      : (row, i) => (row as Record<string, ColumnValue>)[names[i]];

    for (const row of rows) {
      if ((this._chunk as DataChunk).size >= DEFAULT_CHUNK_SIZE) {
        this._chunks.push(this._chunk as DataChunk);
        this._chunk = DataChunk.fromSchema(schema, DEFAULT_CHUNK_SIZE);
      }
      (this._chunk as DataChunk).appendRow(schema.map((col, i) => coerceForColumn(extract(row, i), col.dataType)));
    }
    return this;
  }

  finish(): InMemoryRelation {
    if (this._finished) throw new Error('RelationBuilder: finish() called twice');
    this._finished = true;

    if (this.schema === null) {
      this.schema = this._declaredSchema
        ? this._declaredSchema.map(c => ({ name: c.name, dataType: c.dataType }))
        : [];
      this._chunk = DataChunk.fromSchema(this.schema, DEFAULT_CHUNK_SIZE);
    }
    if ((this._chunk as DataChunk).size > 0 || this._chunks.length === 0) this._chunks.push(this._chunk as DataChunk);

    const relation = new InMemoryRelation(this.schema, this._chunks);
    this._chunk = null;
    this._chunks = [];
    return relation;
  }
}
