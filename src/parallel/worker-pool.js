import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, 'worker-thread.js');

const WORKER_STATE = { IDLE: 0, BUSY: 1, TERMINATED: 2 };

export class WorkerPool {
  constructor({ maxWorkers, wasmModule, wasmMemory, regionAllocator }) {
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

  async init() {
    if (this.initialized) return;

    const spawnPromises = [];
    for (let i = 0; i < this.maxWorkers; i++) {
      spawnPromises.push(this._spawnWorker(i));
    }
    await Promise.all(spawnPromises);

    this.initialized = true;
  }

  async _spawnWorker(id) {
    const regionId = this.regionAllocator.addRegion();
    const bounds = this.regionAllocator.getRegionBounds(regionId);

    const worker = new Worker(WORKER_SCRIPT, {
      workerData: {
        workerId: id,
        wasmModule: this.wasmModule,
        wasmMemory: this.wasmMemory,
        regionId,
        regionStart: bounds.start,
        regionCapacity: bounds.end - bounds.start,
      },
    });

    return new Promise((resolve, reject) => {
      const entry = {
        worker,
        id,
        regionId,
        state: WORKER_STATE.IDLE,
      };

      worker.on('message', (msg) => {
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

      worker.on('error', (err) => {
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

  execute(tasks) {
    return Promise.all(tasks.map(task => this._submitTask(task)));
  }

  executeOnWorker(workerId, task) {
    return this._submitTask(task, workerId);
  }

  _submitTask(task, targetWorkerId) {
    const taskId = this.taskIdCounter++;

    return new Promise((resolve, reject) => {
      const pending = { taskId, task, resolve, reject, targetWorkerId, workerId: null };

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

  _dispatch(entry, taskId, task, pending) {
    entry.state = WORKER_STATE.BUSY;
    pending.workerId = entry.id;
    this.pendingTasks.set(taskId, pending);
    entry.worker.postMessage({ taskId, ...task });
  }

  _drainQueue() {
    while (this.taskQueue.length > 0) {
      const pending = this.taskQueue[0];

      let entry;
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

  _findIdleWorker() {
    for (const entry of this.workers.values()) {
      if (entry.state === WORKER_STATE.IDLE) return entry;
    }
    return null;
  }

  activeWorkerCount() {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (entry.state !== WORKER_STATE.TERMINATED) count++;
    }
    return count;
  }

  idleWorkerCount() {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (entry.state === WORKER_STATE.IDLE) count++;
    }
    return count;
  }

  async resize(newCount) {
    const current = this.activeWorkerCount();

    if (newCount > current) {
      const spawnPromises = [];
      for (let i = current; i < newCount; i++) {
        spawnPromises.push(this._spawnWorker(i));
      }
      await Promise.all(spawnPromises);
      this.maxWorkers = newCount;
    } else if (newCount < current) {
      const toRemove = [];
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

  async _terminateWorker(id) {
    const entry = this.workers.get(id);
    if (!entry) return;

    entry.state = WORKER_STATE.TERMINATED;
    await entry.worker.terminate();
    this.workers.delete(id);
  }

  async shutdown() {
    const terminations = [];
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
