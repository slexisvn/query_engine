import { QueryEngine, setDefaultStorageBackend } from './engine/query-engine.js';
import { MemoryStorageBackend } from './storage/backend/memory-storage-backend.js';
import { configureWasmSource } from './wasm/loader.js';
import { fetchByteSource, setWasmBaseUrl } from './wasm/fetch-byte-source.js';
import { Catalog } from './catalog/catalog.js';
import { DataType } from './storage/data-type.js';
import { InMemoryRelation, RelationBuilder } from './dataframe/in-memory-relation.js';

setDefaultStorageBackend((options) => new MemoryStorageBackend(options));
configureWasmSource(fetchByteSource);

export { QueryEngine, Catalog, DataType, InMemoryRelation, RelationBuilder, setWasmBaseUrl };
export {
  DataFrame, GroupedData,
  Col, col, lit, expr, sum, avg, min, max, count, countStar,
} from './dataframe/index.js';

export function createEngine(options = {}) {
  const catalog = options.catalog || new Catalog();
  return new QueryEngine(catalog, options);
}

export function registerTable(engine, name, rows, declaredSchema = null) {
  const relation = InMemoryRelation.fromRows(rows, declaredSchema);
  const schema = relation.getSchema();
  engine.catalog.registerTable(name, schema);
  engine.catalog.registerTableStorage(name, relation);
  return schema;
}

export async function registerStreamingTable(engine, name, schemaOrBatches, maybeBatches) {
  let declaredSchema = schemaOrBatches;
  let batches = maybeBatches;
  if (batches === undefined) {
    batches = schemaOrBatches;
    declaredSchema = null;
  }

  const builder = InMemoryRelation.builder(declaredSchema);
  for await (const batch of batches) {
    builder.appendRows(batch);
  }
  const relation = builder.finish();

  const schema = relation.getSchema();
  engine.catalog.registerTable(name, schema);
  engine.catalog.registerTableStorage(name, relation);
  return schema;
}
