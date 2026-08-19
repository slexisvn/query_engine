import { getEnvInt, getEnvFloat, getEnvFlag, getCpuCount } from './runtime/platform.js';

export const DEFAULT_CHUNK_SIZE = 2048;

const env = getEnvInt;
const envFlag = getEnvFlag;
const envFloat = getEnvFloat;

const resolveWorkerCount = (): number => {
  const raw = env('QE_PARALLEL_WORKERS', 0);
  if (raw > 0) return raw;
  return Math.max(1, getCpuCount() - 1);
};

export const Config = {
  memoryLimitBytes: env('QE_MEMORY_LIMIT_BYTES', 1 << 28),
  variableWidthValueBytes: env('QE_VARIABLE_WIDTH_VALUE_BYTES', 32),
  materializedRowOverheadBytes: env('QE_MATERIALIZED_ROW_OVERHEAD_BYTES', 48),
  hashJoinPartitions: env('QE_HASH_JOIN_PARTITIONS', 16),
  hashJoinMaxRepartitionDepth: env('QE_HASH_JOIN_MAX_REPARTITION_DEPTH', 4),
  joinRuntimeFilterMinRows: env('QE_JOIN_RUNTIME_FILTER_MIN_ROWS', 1024),
  joinRuntimeFilterCapacity: env('QE_JOIN_RUNTIME_FILTER_CAPACITY', 1 << 20),
  joinRuntimeFilterFalsePositiveRate: envFloat('QE_JOIN_RUNTIME_FILTER_FPP', 0.01),
  flushBatchSize: env('QE_FLUSH_BATCH_SIZE', DEFAULT_CHUNK_SIZE),
  pageCachePages: env('QE_PAGE_CACHE_PAGES', 50),
  wasmMinChunkSize: env('QE_WASM_MIN_CHUNK', 4096),
  sinkQueueCapacity: env('QE_SINK_QUEUE_CAPACITY', 8),
  btreeOrder: env('QE_BTREE_ORDER', 128),
  indexScanSelectivityThreshold: envFloat('QE_INDEX_SELECTIVITY_THRESHOLD', 0.3),
  dependentJoinConcurrency: env('QE_DEPENDENT_JOIN_CONCURRENCY', 1),
  parallelWorkers: resolveWorkerCount(),
  parallelThreshold: env('QE_PARALLEL_THRESHOLD', 10000),
  parallelAggThreshold: env('QE_PARALLEL_AGG_THRESHOLD', 50000),
  aggMorselRows: env('QE_AGG_MORSEL_ROWS', 16384),
  sabColumns: envFlag('QE_SAB_COLUMNS', false),
  sabArenaSegmentBytes: env('QE_SAB_ARENA_SEGMENT_BYTES', 1 << 20),
  parallelAggMemoryBytes: env('QE_PARALLEL_AGG_MEMORY_BYTES', 1 << 28),
  parallelCombineMinGroups: env('QE_PARALLEL_COMBINE_MIN_GROUPS', 8192),
  aggSpillGroups: env('QE_AGG_SPILL_GROUPS', 1 << 17),
  aggSpillPartitions: env('QE_AGG_SPILL_PARTITIONS', 16),
  dedupSpillPartitions: env('QE_DEDUP_SPILL_PARTITIONS', 16),
  vectorGroupRange: env('QE_VECTOR_GROUP_RANGE', 1 << 21),
  parallelJoinThreshold: env('QE_PARALLEL_JOIN_THRESHOLD', 50000),
  transportMaxBuffers: env('QE_TRANSPORT_MAX_BUFFERS', 64),
  aggRadixMultiplier: env('QE_AGG_RADIX_MULTIPLIER', 2),
  regionSize: env('QE_WASM_REGION_SIZE', 16 * 1024 * 1024),
  morselSize: env('QE_MORSEL_SIZE', 262144),

  joinOrderDpMaxRelations: env('QE_JOIN_ORDER_DP_MAX_RELATIONS', 14),
  joinOrderMaxPairs: env('QE_JOIN_ORDER_MAX_PAIRS', 120000),
  optimizerFixpointIterations: env('QE_OPTIMIZER_FIXPOINT_ITERATIONS', 8),
  planCacheEntries: env('QE_PLAN_CACHE_ENTRIES', 256),
  perfectHashAggregateCostFactor: envFloat('QE_PERFECT_HASH_AGG_COST_FACTOR', 0.5),
  pipelineConcurrency: env('QE_PIPELINE_CONCURRENCY', 4),

  clusterPort: env('QE_CLUSTER_PORT', 9400),
  coordinatorSchemaSampleRows: env('QE_COORD_SCHEMA_SAMPLE_ROWS', 1000),
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
  phiAccrualThreshold: envFloat('QE_PHI_THRESHOLD', 8.0),
  networkCostPerByte: envFloat('QE_NETWORK_COST_PER_BYTE', 0.001),
};
