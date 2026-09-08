import { PhysicalPlanner } from './physical-planner.js';
import { MemoryStorageBackend } from '../storage/backend/memory-storage-backend.js';
import type { ExecutionCatalog } from './execution-catalog.js';
import type { ParallelExpressionDispatch, WorkerPoolHandle } from './parallel-context.js';
import type { ChunkSpillStore } from '../storage/spill-manager/spill-manager.js';
import type { FragmentPoolLike as JoinFragmentPoolLike } from './builders/join-builder.js';
import type { FragmentPoolLike as AggFragmentPoolLike } from './builders/aggregate-builder.js';

export interface TempManagerLike {
  allocate(category: string, label: string): string;
}

export interface StorageBackendLike {
  createTempSpace(): object;
  createPageStore(): object;
  createSpillManager(handle: string): ChunkSpillStore;
}

export type FragmentPoolLike = JoinFragmentPoolLike & AggFragmentPoolLike;

export class ExecutionResources {
  catalog: ExecutionCatalog;
  tempManager: TempManagerLike;
  storageBackend: StorageBackendLike;
  physicalPlanner: PhysicalPlanner;
  workerPool: WorkerPoolHandle | null;
  parallelDispatch: ParallelExpressionDispatch | null;
  fragmentPool: FragmentPoolLike | null;

  constructor(catalog: ExecutionCatalog, tempManager: TempManagerLike, storageBackend: StorageBackendLike | null = null) {
    this.catalog = catalog;
    this.tempManager = tempManager;
    this.storageBackend = storageBackend ?? new MemoryStorageBackend();
    this.physicalPlanner = new PhysicalPlanner();
    this.workerPool = null;
    this.parallelDispatch = null;
    this.fragmentPool = null;
  }
}
