import { QueryEngine, setDefaultStorageBackend } from './engine/query-engine.js';
import { NodeStorageBackend } from './storage/backend/node-storage-backend.js';
import { configureWasmSource } from './wasm/loader.js';
import { nodeByteSource } from './wasm/node-byte-source.js';
import { Catalog } from './catalog/catalog.js';
import { DataType } from './storage/data-type.js';
import { InMemoryRelation, RelationBuilder } from './dataframe/in-memory-relation.js';
import { Table } from './storage/table.js';
import { Config, DEFAULT_CHUNK_SIZE } from './config.js';
import type { StorageBackendOptions } from './storage/backend/memory-storage-backend.js';

setDefaultStorageBackend((options) => new NodeStorageBackend(options as StorageBackendOptions));
configureWasmSource(nodeByteSource);

export { QueryEngine, Catalog, DataType, InMemoryRelation, RelationBuilder, Table, Config, DEFAULT_CHUNK_SIZE };
export {
  DataFrame, GroupedData,
  Col, col, lit, expr, sum, avg, min, max, count, countStar,
} from './dataframe/index.js';
export { createEngine, registerTable, registerStreamingTable } from './engine-entry.js';
export { NodeDescriptor, NodeRole } from './distributed/cluster/node-descriptor.js';
export { RoundRobinPartitionStrategy } from './distributed/partition/partition-strategy.js';
export { HttpTransport } from './distributed/transport/http-transport.js';
export { FragmentExecutor } from './distributed/execution/fragment-executor.js';
export { Fragment } from './distributed/planner/fragment.js';
export type { ColumnSchema, ColumnValue } from './storage/data-type.js';
export type { DataChunk } from './storage/chunk.js';
export type { QueryCoordinator } from './distributed/execution/coordinator.js';
export type { ClusterManager } from './distributed/cluster/cluster-manager.js';
export type { PartitionMap } from './distributed/partition/partition-map.js';
export type {
  ControlMessage,
  ExchangeType,
  FragmentDispatchJSON,
  HeartbeatMessage,
  NodeId,
  NodeRegistration,
  OutputConfig,
  PartitionId,
} from './distributed/distributed-types.js';
