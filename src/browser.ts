import { QueryEngine, setDefaultStorageBackend } from './engine/query-engine.js';
import { MemoryStorageBackend, StorageBackendOptions } from './storage/backend/memory-storage-backend.js';
import { configureWasmSource } from './wasm/loader.js';
import { fetchByteSource, setWasmBaseUrl } from './wasm/fetch-byte-source.js';
import { Catalog } from './catalog/catalog.js';
import { DataType } from './storage/data-type.js';
import { InMemoryRelation, RelationBuilder } from './dataframe/in-memory-relation.js';

type StorageBackendFactory = Parameters<typeof setDefaultStorageBackend>[0];

setDefaultStorageBackend(((options: StorageBackendOptions) => new MemoryStorageBackend(options)) as StorageBackendFactory);
configureWasmSource(fetchByteSource);

export { QueryEngine, Catalog, DataType, InMemoryRelation, RelationBuilder, setWasmBaseUrl };
export {
  DataFrame, GroupedData,
  Col, col, lit, expr, sum, avg, min, max, count, countStar,
} from './dataframe/index.js';
export { createEngine, registerTable, registerStreamingTable } from './engine-entry.js';
