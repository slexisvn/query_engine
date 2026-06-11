import { QueryEngine, setDefaultStorageBackend } from './engine/query-engine.js';
import { MemoryStorageBackend } from './storage/backend/memory-storage-backend.js';
import { configureWasmSource } from './wasm/loader.js';
import { fetchByteSource, setWasmBaseUrl } from './wasm/fetch-byte-source.js';
import { Catalog } from './catalog/catalog.js';
import { DataType } from './storage/data-type.js';
import { InMemoryRelation } from './dataframe/in-memory-relation.js';

setDefaultStorageBackend((options) => new MemoryStorageBackend(options));
configureWasmSource(fetchByteSource);

export { QueryEngine, Catalog, DataType, InMemoryRelation, setWasmBaseUrl };

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
