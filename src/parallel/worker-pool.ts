import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type {
  WorkerTask,
  WorkerTaskMessage,
  WorkerResultData,
  WorkerOutboundMessage,
  WorkerInitData,
} from './worker-messages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, 'worker-thread.js');

const WORKER_STATE = { IDLE: 0, BUSY: 1, TERMINATED: 2 } as const;

type WorkerStateValue = typeof WORKER_STATE[keyof typeof WORKER_STATE];

interface RegionBounds {
  start: number;
  end: number;
}

interface RegionAllocatorLike {
  addRegion(): number;
  getRegionBounds(regionId: number): RegionBounds;
}

interface WorkerPoolOptions {
  maxWorkers: number;
  wasmModule: WebAssembly.Module;
  wasmMemory: WebAssembly.Memory;
  regionAllocator: RegionAllocatorLike;
}

interface WorkerEntry {
  worker: Worker;
  id: number;
  regionId: number;
  state: WorkerStateValue;
}

interface PendingTask {
  taskId: number;
  task: WorkerTask;
  resolve: (value: WorkerResultData) => void;
  reject: (reason: Error) => void;
  targetWorkerId: number | undefined;
  workerId: number | null;
}

export class WorkerPool {
  maxWorkers: number;
  wasmModule: WebAssembly.Module;
  wasmMemory: WebAssembly.Memory;
  regionAllocator: RegionAllocatorLike;
  workers: Map<number, WorkerEntry>;
  taskQueue: PendingTask[];
  taskIdCounter: number;
  pendingTasks: Map<number, PendingTask>;
  initialized: boolean;

  constructor({ maxWorkers, wasmModule, wasmMemory, regionAllocator }: WorkerPoolOptions) {
    this.maxWorkers = maxWorkers;
    this.wasmModule = wasmModule;
    this.wasmMemory = wasmMemory;
    this.regionAllocator = regionAllocator;
    this.workers = new Map();
    this.taskQueue = [];
    this.taskIdCounter = 0;
    this.pendingTasks = new Map();
    this.initialized = false;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const spawnPromises: Promise<void>[] = [];
    for (let i = 0; i < this.maxWorkers; i++) {
      spawnPromises.push(this._spawnWorker(i));
    }
    await Promise.all(spawnPromises);

    this.initialized = true;
  }

  async _spawnWorker(id: number): Promise<void> {
    const regionId = this.regionAllocator.addRegion();
    const bounds = this.regionAllocator.getRegionBounds(regionId);

    const workerData: WorkerInitData = {
      workerId: id,
      wasmModule: this.wasmModule,
      wasmMemory: this.wasmMemory,
      regionId,
      regionStart: bounds.start,
      regionCapacity: bounds.end - bounds.start,
    };

    const worker = new Worker(WORKER_SCRIPT, {
      workerData,
    });

    return new Promise<void>((resolve, reject) => {
      const entry: WorkerEntry = {
        worker,
        id,
        regionId,
        state: WORKER_STATE.IDLE,
      };

      worker.on('message', (msg: WorkerOutboundMessage) => {
        if (msg.type === 'ready') {
          this.workers.set(id, entry);
          resolve();
          return;
        }

        if (msg.type === 'result') {
          const pending = this.pendingTasks.get(msg.taskId);
          if (pending) {
            this.pendingTasks.delete(msg.taskId);
            entry.state = WORKER_STATE.IDLE;
            pending.resolve(msg.data);
            this._drainQueue();
          }
          return;
        }

        if (msg.type === 'error') {
          const pending = this.pendingTasks.get(msg.taskId);
          if (pending) {
            this.pendingTasks.delete(msg.taskId);
            entry.state = WORKER_STATE.IDLE;
            pending.reject(new Error(msg.error));
            this._drainQueue();
          }
        }
      });

      worker.on('error', (err: Error) => {
        entry.state = WORKER_STATE.TERMINATED;
        for (const [taskId, pending] of this.pendingTasks) {
          if (pending.workerId === id) {
            this.pendingTasks.delete(taskId);
            pending.reject(err);
          }
        }
        reject(err);
      });
    });
  }

  execute(tasks: WorkerTask[]): Promise<WorkerResultData[]> {
    return Promise.all(tasks.map(task => this._submitTask(task)));
  }

  executeOnWorker(workerId: number, task: WorkerTask): Promise<WorkerResultData> {
    return this._submitTask(task, workerId);
  }

  _submitTask(task: WorkerTask, targetWorkerId?: number): Promise<WorkerResultData> {
    const taskId = this.taskIdCounter++;

    return new Promise<WorkerResultData>((resolve, reject) => {
      const pending: PendingTask = { taskId, task, resolve, reject, targetWorkerId, workerId: null };

      if (targetWorkerId !== undefined) {
        const entry = this.workers.get(targetWorkerId);
        if (!entry || entry.state === WORKER_STATE.TERMINATED) {
          reject(new Error(`Worker ${targetWorkerId} not available`));
          return;
        }

        if (entry.state === WORKER_STATE.IDLE) {
          this._dispatch(entry, taskId, task, pending);
          return;
        }

        this.taskQueue.push(pending);
        this.pendingTasks.set(taskId, pending);
        return;
      }

      const idle = this._findIdleWorker();
      if (idle) {
        this._dispatch(idle, taskId, task, pending);
        return;
      }

      this.taskQueue.push(pending);
      this.pendingTasks.set(taskId, pending);
    });
  }

  _dispatch(entry: WorkerEntry, taskId: number, task: WorkerTask, pending: PendingTask): void {
    entry.state = WORKER_STATE.BUSY;
    pending.workerId = entry.id;
    this.pendingTasks.set(taskId, pending);
    const message: WorkerTaskMessage = { taskId, ...task };
    entry.worker.postMessage(message);
  }

  _drainQueue(): void {
    while (this.taskQueue.length > 0) {
      const pending = this.taskQueue[0];

      let entry: WorkerEntry | null | undefined;
      if (pending.targetWorkerId !== undefined) {
        entry = this.workers.get(pending.targetWorkerId);
        if (!entry || entry.state !== WORKER_STATE.IDLE) return;
      } else {
        entry = this._findIdleWorker();
        if (!entry) return;
      }

      this.taskQueue.shift();
      this._dispatch(entry, pending.taskId, pending.task, pending);
    }
  }

  _findIdleWorker(): WorkerEntry | null {
    for (const entry of this.workers.values()) {
      if (entry.state === WORKER_STATE.IDLE) return entry;
    }
    return null;
  }

  activeWorkerCount(): number {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (entry.state !== WORKER_STATE.TERMINATED) count++;
    }
    return count;
  }

  idleWorkerCount(): number {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (entry.state === WORKER_STATE.IDLE) count++;
    }
    return count;
  }

  async resize(newCount: number): Promise<void> {
    const current = this.activeWorkerCount();

    if (newCount > current) {
      const spawnPromises: Promise<void>[] = [];
      for (let i = current; i < newCount; i++) {
        spawnPromises.push(this._spawnWorker(i));
      }
      await Promise.all(spawnPromises);
      this.maxWorkers = newCount;
    } else if (newCount < current) {
      const toRemove: number[] = [];
      for (const [id, entry] of this.workers) {
        if (toRemove.length >= current - newCount) break;
        if (entry.state === WORKER_STATE.IDLE) {
          toRemove.push(id);
        }
      }
      for (const id of toRemove) {
        await this._terminateWorker(id);
      }
      this.maxWorkers = newCount;
    }
  }

  async _terminateWorker(id: number): Promise<void> {
    const entry = this.workers.get(id);
    if (!entry) return;

    entry.state = WORKER_STATE.TERMINATED;
    await entry.worker.terminate();
    this.workers.delete(id);
  }

  async shutdown(): Promise<void> {
    const terminations: Promise<void>[] = [];
    for (const id of [...this.workers.keys()]) {
      terminations.push(this._terminateWorker(id));
    }
    await Promise.all(terminations);

    for (const [, pending] of this.pendingTasks) {
      pending.reject(new Error('Worker pool shut down'));
    }
    this.pendingTasks.clear();
    this.taskQueue.length = 0;
    this.initialized = false;
  }
}
