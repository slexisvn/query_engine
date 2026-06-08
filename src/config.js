import { DEFAULT_CHUNK_SIZE } from './storage/chunk.js';
import { availableParallelism } from 'os';

const env = (key, fallback) => {
  const val = process.env[key];
  return val !== undefined ? parseInt(val, 10) : fallback;
};

const resolveWorkerCount = () => {
  const raw = env('QE_PARALLEL_WORKERS', 0);
  if (raw > 0) return raw;
  return Math.max(1, availableParallelism() - 1);
};

export const Config = {
  memoryLimit: env('QE_MEMORY_LIMIT', 200000),
  hashJoinPartitions: env('QE_HASH_JOIN_PARTITIONS', 16),
  flushBatchSize: env('QE_FLUSH_BATCH_SIZE', DEFAULT_CHUNK_SIZE),
  bufferPoolPages: env('QE_BUFFER_POOL_PAGES', 50),
  wasmMinChunkSize: env('QE_WASM_MIN_CHUNK', 4096),
  sinkQueueCapacity: env('QE_SINK_QUEUE_CAPACITY', 8),
  btreeOrder: env('QE_BTREE_ORDER', 128),
  indexScanSelectivityThreshold: parseFloat(process.env.QE_INDEX_SELECTIVITY_THRESHOLD || '0.3'),
  dependentJoinConcurrency: env('QE_DEPENDENT_JOIN_CONCURRENCY', 1),
  parallelWorkers: resolveWorkerCount(),
  parallelThreshold: env('QE_PARALLEL_THRESHOLD', 10000),
  regionSize: env('QE_WASM_REGION_SIZE', 16 * 1024 * 1024),
  morselSize: env('QE_MORSEL_SIZE', 262144),
};
