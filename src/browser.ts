import { QueryEngine, setDefaultStorageBackend } from './engine/query-engine.js';
import { MemoryStorageBackend, StorageBackendOptions } from './storage/backend/memory-storage-backend.js';
import { configureWasmSource } from './wasm/loader.js';
import { fetchByteSource, setWasmBaseUrl } from './wasm/fetch-byte-source.js';
import { Catalog } from './catalog/catalog.js';
import { DataType } from './storage/data-type.js';
import type { ColumnSchema, ColumnValue } from './storage/data-type.js';
import type { Table } from './storage/table.js';
import { InMemoryRelation, RelationBuilder } from './dataframe/in-memory-relation.js';

type RowInput = Record<string, ColumnValue> | ColumnValue[];

type StorageBackendFactory = Parameters<typeof setDefaultStorageBackend>[0];

type QueryEngineOptions = ConstructorParameters<typeof QueryEngine>[1];

type CreateEngineOptions = QueryEngineOptions & { catalog?: Catalog };

setDefaultStorageBackend(((options: StorageBackendOptions) => new MemoryStorageBackend(options)) as StorageBackendFactory);
configureWasmSource(fetchByteSource);

export { QueryEngine, Catalog, DataType, InMemoryRelation, RelationBuilder, setWasmBaseUrl };
export {
  DataFrame, GroupedData,
  Col, col, lit, expr, sum, avg, min, max, count, countStar,
} from './dataframe/index.js';

export function createEngine(options: CreateEngineOptions = {}): QueryEngine {
  const catalog = options.catalog || new Catalog();
  return new QueryEngine(catalog, options);
}

export function registerTable(engine: QueryEngine, name: string, rows: RowInput[], declaredSchema: ColumnSchema[] | null = null): ColumnSchema[] {
  const relation = InMemoryRelation.fromRows(rows, declaredSchema);
  const schema = relation.getSchema();
  engine.catalog.registerTable(name, schema);
  engine.catalog.registerTableStorage(name, relation as object as Table);
  return schema;
}

export async function registerStreamingTable(engine: QueryEngine, name: string, schemaOrBatches: ColumnSchema[] | AsyncIterable<RowInput[]> | null, maybeBatches?: AsyncIterable<RowInput[]>): Promise<ColumnSchema[]> {
  let declaredSchema: ColumnSchema[] | null = schemaOrBatches as ColumnSchema[] | null;
  let batches: AsyncIterable<RowInput[]> | undefined = maybeBatches;
  if (batches === undefined) {
    batches = schemaOrBatches as AsyncIterable<RowInput[]>;
    declaredSchema = null;
  }

  const builder = InMemoryRelation.builder(declaredSchema);
  for await (const batch of batches) {
    builder.appendRows(batch);
  }
  const relation = builder.finish();

  const schema = relation.getSchema();
  engine.catalog.registerTable(name, schema);
  engine.catalog.registerTableStorage(name, relation as object as Table);
  return schema;
}
