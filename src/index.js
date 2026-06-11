import { QueryEngine, setDefaultStorageBackend } from './engine/query-engine.js';
import { NodeStorageBackend } from './storage/backend/node-storage-backend.js';
import { configureWasmSource } from './wasm/loader.js';
import { nodeByteSource } from './wasm/node-byte-source.js';

setDefaultStorageBackend((options) => new NodeStorageBackend(options));
configureWasmSource(nodeByteSource);

export { QueryEngine };
