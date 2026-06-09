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

  clusterPort: env('QE_CLUSTER_PORT', 9400),
  heartbeatIntervalMs: env('QE_HEARTBEAT_INTERVAL', 3000),
  heartbeatTimeoutMs: env('QE_HEARTBEAT_TIMEOUT', 10000),
  defaultPartitionCount: env('QE_PARTITION_COUNT', 16),
  broadcastThreshold: env('QE_BROADCAST_THRESHOLD', 10000),
  exchangeBatchSize: env('QE_EXCHANGE_BATCH_SIZE', 4096),
  exchangeBufferCapacity: env('QE_EXCHANGE_BUFFER_CAPACITY', 8),
  fragmentRetryLimit: env('QE_FRAGMENT_RETRY_LIMIT', 3),
  coordinatorTimeoutMs: env('QE_COORDINATOR_TIMEOUT', 300000),
  codecCompression: env('QE_CODEC_COMPRESSION', 0),
  distributedWorkers: env('QE_DISTRIBUTED_WORKERS', 0),
  phiAccrualWindowSize: env('QE_PHI_WINDOW_SIZE', 100),
  phiAccrualThreshold: parseFloat(process.env.QE_PHI_THRESHOLD || '8.0'),
  networkCostPerByte: parseFloat(process.env.QE_NETWORK_COST_PER_BYTE || '0.001'),
};
