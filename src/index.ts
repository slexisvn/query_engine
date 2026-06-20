import { QueryEngine, setDefaultStorageBackend } from './engine/query-engine.js';
import { NodeStorageBackend } from './storage/backend/node-storage-backend.js';
import { configureWasmSource } from './wasm/loader.js';
import { nodeByteSource } from './wasm/node-byte-source.js';
import { Catalog } from './catalog/catalog.js';
import { DataType } from './storage/data-type.js';
import { InMemoryRelation, RelationBuilder } from './dataframe/in-memory-relation.js';
import type { StorageBackendOptions } from './storage/backend/memory-storage-backend.js';
import type { ColumnSchema, ColumnValue } from './storage/data-type.js';
import type { Table } from './storage/table.js';

type RowInputLike = Record<string, ColumnValue> | ColumnValue[];

type QueryEngineOptions = ConstructorParameters<typeof QueryEngine>[1];

type CreateEngineOptions = QueryEngineOptions & { catalog?: Catalog };

setDefaultStorageBackend((options) => new NodeStorageBackend(options as StorageBackendOptions));
configureWasmSource(nodeByteSource);

export { QueryEngine, Catalog, DataType, InMemoryRelation, RelationBuilder };
export {
  DataFrame, GroupedData,
  Col, col, lit, expr, sum, avg, min, max, count, countStar,
} from './dataframe/index.js';

export function createEngine(options: CreateEngineOptions = {}): QueryEngine {
  const catalog = options.catalog || new Catalog();
  return new QueryEngine(catalog, options);
}

export function registerTable(engine: QueryEngine, name: string, rows: RowInputLike[], declaredSchema: ColumnSchema[] | null = null): ColumnSchema[] {
  const relation = InMemoryRelation.fromRows(rows, declaredSchema);
  const schema = relation.getSchema();
  engine.catalog.registerTable(name, schema);
  engine.catalog.registerTableStorage(name, relation as object as Table);
  return schema;
}

export async function registerStreamingTable(engine: QueryEngine, name: string, schemaOrBatches: ColumnSchema[] | null | AsyncIterable<RowInputLike[]>, maybeBatches?: AsyncIterable<RowInputLike[]>): Promise<ColumnSchema[]> {
  let declaredSchema = schemaOrBatches as ColumnSchema[] | null;
  let batches = maybeBatches;
  if (batches === undefined) {
    batches = schemaOrBatches as AsyncIterable<RowInputLike[]>;
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
