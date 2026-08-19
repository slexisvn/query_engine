import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerPool } from '../../src/parallel/worker-pool.js';

function mockRegionAllocator() {
  let regionCounter = 0;
  return {
    addRegion: vi.fn(() => regionCounter++),
    getRegionBounds: vi.fn((id) => ({ start: id * 65536, end: (id + 1) * 65536 })),
    memory: { buffer: new ArrayBuffer(1024 * 1024) },
    resetStaging: vi.fn(),
    allocStaging: vi.fn(() => 0),
  };
}

describe('WorkerPool', () => {
  let pool;

  beforeEach(() => {
    pool = new WorkerPool({
      maxWorkers: 4,
      wasmModule: null,
      wasmMemory: null,
      regionAllocator: mockRegionAllocator(),
    });
  });

  describe('construction', () => {
    it('sets maxWorkers from config', () => {
      expect(pool.maxWorkers).toBe(4);
    });

    it('starts uninitialized', () => {
      expect(pool.initialized).toBe(false);
    });

    it('starts with empty workers map', () => {
      expect(pool.workers.size).toBe(0);
    });

    it('starts with empty task queue', () => {
      expect(pool.taskQueue.length).toBe(0);
    });

    it('starts with zero task counter', () => {
      expect(pool.taskIdCounter).toBe(0);
    });

    it('stores regionAllocator reference', () => {
      expect(pool.regionAllocator).toBeDefined();
    });
  });

  describe('activeWorkerCount', () => {
    it('returns 0 with no workers', () => {
      expect(pool.activeWorkerCount()).toBe(0);
    });

    it('counts non-terminated workers', () => {
      pool.workers.set(0, { state: 0, worker: {} });
      pool.workers.set(1, { state: 1, worker: {} });
      pool.workers.set(2, { state: 2, worker: {} });

      expect(pool.activeWorkerCount()).toBe(2);
    });
  });

  describe('idleWorkerCount', () => {
    it('returns 0 with no workers', () => {
      expect(pool.idleWorkerCount()).toBe(0);
    });

    it('counts only idle (state=0) workers', () => {
      pool.workers.set(0, { state: 0, worker: {} });
      pool.workers.set(1, { state: 1, worker: {} });
      pool.workers.set(2, { state: 0, worker: {} });

      expect(pool.idleWorkerCount()).toBe(2);
    });
  });

  describe('_findIdleWorker', () => {
    it('returns null with no workers', () => {
      expect(pool._findIdleWorker()).toBeNull();
    });

    it('returns null when all busy', () => {
      pool.workers.set(0, { state: 1 });
      pool.workers.set(1, { state: 1 });

      expect(pool._findIdleWorker()).toBeNull();
    });

    it('returns first idle worker', () => {
      pool.workers.set(0, { state: 1, id: 0 });
      pool.workers.set(1, { state: 0, id: 1 });
      pool.workers.set(2, { state: 0, id: 2 });

      const idle = pool._findIdleWorker();
      expect(idle).not.toBeNull();
      expect(idle.state).toBe(0);
    });
  });

  describe('execute', () => {
    it('returns a promise for each task', () => {
      pool.workers.set(0, {
        id: 0,
        state: 0,
        worker: { postMessage: vi.fn() },
      });

      const result = pool.execute([{ type: 'test' }]);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('_dispatch', () => {
    it('sets worker state to BUSY and sends message', () => {
      const worker = { postMessage: vi.fn() };
      const entry = { id: 0, state: 0, worker };
      const pending = { workerId: null };

      pool._dispatch(entry, 42, { type: 'test', data: 'hello' }, pending);

      expect(entry.state).toBe(1);
      expect(pending.workerId).toBe(0);
      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 42, type: 'test', data: 'hello' })
      );
      expect(pool.pendingTasks.has(42)).toBe(true);
    });
  });

  describe('_submitTask', () => {
    it('dispatches immediately to idle worker', () => {
      const worker = { postMessage: vi.fn() };
      pool.workers.set(0, { id: 0, state: 0, worker });

      pool._submitTask({ type: 'job1' });

      expect(pool.workers.get(0).state).toBe(1);
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    });

    it('queues when all workers are busy', () => {
      pool.workers.set(0, { id: 0, state: 1, worker: { postMessage: vi.fn() } });

      pool._submitTask({ type: 'queued' });

      expect(pool.taskQueue.length).toBe(1);
    });

    it('rejects when targeted worker is terminated', async () => {
      pool.workers.set(0, { id: 0, state: 2, worker: {} });

      await expect(pool._submitTask({ type: 'fail' }, 0)).rejects.toThrow('not available');
    });

    it('dispatches to specific worker when idle', () => {
      const w0 = { postMessage: vi.fn() };
      const w1 = { postMessage: vi.fn() };
      pool.workers.set(0, { id: 0, state: 0, worker: w0 });
      pool.workers.set(1, { id: 1, state: 0, worker: w1 });

      pool._submitTask({ type: 'targeted' }, 1);

      expect(w1.postMessage).toHaveBeenCalled();
      expect(w0.postMessage).not.toHaveBeenCalled();
    });

    it('queues when targeted worker is busy', () => {
      pool.workers.set(0, { id: 0, state: 1, worker: { postMessage: vi.fn() } });

      pool._submitTask({ type: 'wait' }, 0);

      expect(pool.taskQueue.length).toBe(1);
    });
  });

  describe('_drainQueue', () => {
    it('dispatches queued task when worker becomes idle', () => {
      const worker = { postMessage: vi.fn() };
      const entry = { id: 0, state: 0, worker };
      pool.workers.set(0, entry);

      const pending = {
        taskId: 5,
        task: { type: 'deferred' },
        resolve: vi.fn(),
        reject: vi.fn(),
        workerId: null,
      };
      pool.taskQueue.push(pending);
      pool.pendingTasks.set(5, pending);

      pool._drainQueue();

      expect(pool.taskQueue.length).toBe(0);
      expect(entry.state).toBe(1);
      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 5, type: 'deferred' })
      );
    });

    it('does not drain when no idle workers', () => {
      pool.workers.set(0, { id: 0, state: 1, worker: { postMessage: vi.fn() } });

      pool.taskQueue.push({ taskId: 1, task: {}, resolve: vi.fn(), reject: vi.fn() });

      pool._drainQueue();

      expect(pool.taskQueue.length).toBe(1);
    });

    it('drains multiple tasks in order', () => {
      const w0 = { postMessage: vi.fn() };
      const w1 = { postMessage: vi.fn() };
      pool.workers.set(0, { id: 0, state: 0, worker: w0 });
      pool.workers.set(1, { id: 1, state: 0, worker: w1 });

      for (let i = 0; i < 3; i++) {
        pool.taskQueue.push({
          taskId: i,
          task: { type: `t${i}` },
          resolve: vi.fn(),
          reject: vi.fn(),
          workerId: null,
        });
        pool.pendingTasks.set(i, pool.taskQueue[pool.taskQueue.length - 1]);
      }

      pool._drainQueue();

      expect(pool.taskQueue.length).toBe(1);
      expect(w0.postMessage).toHaveBeenCalledTimes(1);
      expect(w1.postMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown', () => {
    it('clears all state', async () => {
      pool.workers.set(0, {
        id: 0,
        state: 0,
        worker: { terminate: vi.fn().mockResolvedValue(undefined) },
      });
      pool.taskQueue.push({});
      pool.pendingTasks.set(99, {
        resolve: vi.fn(),
        reject: vi.fn(),
      });

      await pool.shutdown();

      expect(pool.workers.size).toBe(0);
      expect(pool.taskQueue.length).toBe(0);
      expect(pool.pendingTasks.size).toBe(0);
      expect(pool.initialized).toBe(false);
    });

    it('rejects all pending tasks with shutdown error', async () => {
      const reject = vi.fn();
      pool.pendingTasks.set(1, { resolve: vi.fn(), reject });

      await pool.shutdown();

      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('shut down') }));
    });

    it('terminates all worker threads', async () => {
      const terminate0 = vi.fn().mockResolvedValue(undefined);
      const terminate1 = vi.fn().mockResolvedValue(undefined);
      pool.workers.set(0, { id: 0, state: 0, worker: { terminate: terminate0 } });
      pool.workers.set(1, { id: 1, state: 1, worker: { terminate: terminate1 } });

      await pool.shutdown();

      expect(terminate0).toHaveBeenCalled();
      expect(terminate1).toHaveBeenCalled();
    });
  });

  describe('resize', () => {
    it('terminates idle workers when shrinking', async () => {
      const term = vi.fn().mockResolvedValue(undefined);
      pool.workers.set(0, { id: 0, state: 0, worker: { terminate: term } });
      pool.workers.set(1, { id: 1, state: 0, worker: { terminate: vi.fn().mockResolvedValue(undefined) } });

      await pool.resize(1);

      expect(pool.maxWorkers).toBe(1);
      expect(pool.workers.size).toBe(1);
    });

    it('does not terminate busy workers when shrinking', async () => {
      pool.workers.set(0, { id: 0, state: 1, worker: { terminate: vi.fn() } });
      pool.workers.set(1, { id: 1, state: 1, worker: { terminate: vi.fn() } });

      await pool.resize(1);

      expect(pool.workers.size).toBe(2);
    });
  });

  describe('executeOnWorker', () => {
    it('delegates to _submitTask with target worker id', () => {
      const worker = { postMessage: vi.fn() };
      pool.workers.set(3, { id: 3, state: 0, worker });

      pool.executeOnWorker(3, { type: 'specific' });

      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'specific' })
      );
    });
  });
});
