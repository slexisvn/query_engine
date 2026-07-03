import { QueryEngine, setDefaultStorageBackend } from './engine/query-engine.js';
import { NodeStorageBackend } from './storage/backend/node-storage-backend.js';
import { configureWasmSource } from './wasm/loader.js';
import { nodeByteSource } from './wasm/node-byte-source.js';
import { Catalog } from './catalog/catalog.js';
import { DataType } from './storage/data-type.js';
import { InMemoryRelation, RelationBuilder } from './dataframe/in-memory-relation.js';
import type { StorageBackendOptions } from './storage/backend/memory-storage-backend.js';

setDefaultStorageBackend((options) => new NodeStorageBackend(options as StorageBackendOptions));
configureWasmSource(nodeByteSource);

export { QueryEngine, Catalog, DataType, InMemoryRelation, RelationBuilder };
export {
  DataFrame, GroupedData,
  Col, col, lit, expr, sum, avg, min, max, count, countStar,
} from './dataframe/index.js';
export { createEngine, registerTable, registerStreamingTable } from './engine-entry.js';
