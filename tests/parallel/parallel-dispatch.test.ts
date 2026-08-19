import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParallelDispatch } from '../../src/parallel/parallel-dispatch.js';

function mockWorkerPool(workerCount = 4) {
  return {
    _workerCount: workerCount,
    activeWorkerCount: vi.fn(function () { return this._workerCount; }),
    execute: vi.fn(async (tasks) => {
      return tasks.map(t => {
        if (t.type === 'filter') {
          return { matchCount: 2, selectionVector: new Uint32Array([t.baseIndex, t.baseIndex + 1]) };
        }
        if (t.type === 'aggregate') {
          if (t.aggType === 'sum') return { result: 100, count: t.count };
          if (t.aggType === 'min') return { result: 1, count: t.count };
          if (t.aggType === 'max') return { result: 999, count: t.count };
          return { result: 0, count: t.count };
        }
        if (t.type === 'filter_compound') {
          return { matchCount: 1, selectionVector: new Uint32Array([t.baseIndex]) };
        }
        if (t.type === 'pipeline') {
          if (t.stages.some(s => s.kind === 'aggregate')) {
            return { aggregates: [{ aggType: 'sum', result: 50, count: t.count }] };
          }
          return { matchCount: t.count, selectionVector: new Uint32Array(t.count) };
        }
        if (t.type === 'project') {
          return { resultData: new Float64Array(t.count), count: t.count };
        }
        return {};
      });
    }),
  };
}

function mockRegionAllocator() {
  const buffer = new ArrayBuffer(1024 * 1024);
  return {
    memory: { buffer },
    resetStaging: vi.fn(),
    allocStaging: vi.fn(() => 0),
  };
}

function mockGlobalDispatch() {
  return {
    lookup: vi.fn((operation, dataType) => {
      if (operation.startsWith('filter')) {
        return async (data, value, high) => {
          const sv = [];
          for (let i = 0; i < data.length; i++) {
            if (operation === 'filterEq' && data[i] === value) sv.push(i);
            if (operation === 'filterGt' && data[i] > value) sv.push(i);
            if (operation === 'filterLt' && data[i] < value) sv.push(i);
            if (operation === 'filterGe' && data[i] >= value) sv.push(i);
            if (operation === 'filterLe' && data[i] <= value) sv.push(i);
            if (operation === 'filterBetween' && data[i] >= value && data[i] <= high) sv.push(i);
          }
          return new Uint32Array(sv);
        };
      }
      if (operation === 'sumI32' || operation === 'sumF64') {
        return async (data) => {
          let s = 0;
          for (let i = 0; i < data.length; i++) s += data[i];
          return s;
        };
      }
      if (operation === 'minI32' || operation === 'minF64') {
        return async (data) => {
          let m = data[0];
          for (let i = 1; i < data.length; i++) if (data[i] < m) m = data[i];
          return m;
        };
      }
      return null;
    }),
  };
}

describe('ParallelDispatch', () => {
  let pool;
  let alloc;
  let dispatch;
  let pd;

  beforeEach(() => {
    pool = mockWorkerPool();
    alloc = mockRegionAllocator();
    dispatch = mockGlobalDispatch();
    pd = new ParallelDispatch(pool, alloc, dispatch);
  });

  describe('canParallelize', () => {
    it('returns true for parallelizable filter on INT32', () => {
      expect(pd.canParallelize('filterEq', 'INT32', 20000)).toBe(true);
    });

    it('returns true for aggregate operations', () => {
      expect(pd.canParallelize('sum', 'FLOAT64', 20000)).toBe(true);
      expect(pd.canParallelize('min', 'INT32', 20000)).toBe(true);
      expect(pd.canParallelize('max', 'INT32', 20000)).toBe(true);
    });

    it('returns false when count below threshold', () => {
      expect(pd.canParallelize('filterEq', 'INT32', 100)).toBe(false);
    });

    it('returns false for VARCHAR', () => {
      expect(pd.canParallelize('filterEq', 'VARCHAR', 20000)).toBe(false);
    });

    it('returns false when no pool', () => {
      const pd2 = new ParallelDispatch(null, alloc, dispatch);
      expect(pd2.canParallelize('filterEq', 'INT32', 20000)).toBe(false);
    });

    it('returns false for unknown operations', () => {
      expect(pd.canParallelize('unknownOp', 'INT32', 20000)).toBe(false);
    });

    it('supports DATE type', () => {
      expect(pd.canParallelize('filterGt', 'DATE', 20000)).toBe(true);
    });

    it('returns true for all filter variants', () => {
      for (const op of ['filterEq', 'filterLt', 'filterGt', 'filterLe', 'filterGe', 'filterBetween']) {
        expect(pd.canParallelize(op, 'INT32', 20000)).toBe(true);
      }
    });
  });

  describe('filterParallel - worker path', () => {
    it('creates correctly structured tasks for workers', async () => {
      const data = new Int32Array(20000);
      await pd.filterParallel(data, 20000, 'filterEq', 'INT32', { value: 42 });

      expect(pool.execute).toHaveBeenCalledTimes(1);
      const tasks = pool.execute.mock.calls[0][0];
      expect(tasks.length).toBeGreaterThan(1);

      for (const task of tasks) {
        expect(task.type).toBe('filter');
        expect(task.operation).toBe('filterEq');
        expect(task.dataType).toBe('INT32');
        expect(task.value).toBe(42);
        expect(task.count).toBeGreaterThan(0);
        expect(typeof task.dataOffset).toBe('number');
        expect(typeof task.baseIndex).toBe('number');
      }

      let totalCount = 0;
      for (const task of tasks) totalCount += task.count;
      expect(totalCount).toBe(20000);
    });

    it('gathers selection vectors from all morsel results', async () => {
      pool.execute.mockResolvedValueOnce([
        { matchCount: 2, selectionVector: new Uint32Array([0, 5]) },
        { matchCount: 3, selectionVector: new Uint32Array([100, 105, 110]) },
        { matchCount: 0 },
      ]);

      const data = new Int32Array(20000);
      const result = await pd.filterParallel(data, 20000, 'filterEq', 'INT32', { value: 42 });

      expect(result.matchCount).toBe(5);
      expect([...result.selectionVector]).toEqual([0, 5, 100, 105, 110]);
    });
  });

  describe('filterParallel - fallback path', () => {
    it('runs real scalar filter for small data', async () => {
      const data = new Int32Array([1, 2, 3, 42, 5, 42]);
      const result = await pd.filterParallel(data, 6, 'filterEq', 'INT32', { value: 42 });

      expect(pool.execute).not.toHaveBeenCalled();
      expect(dispatch.lookup).toHaveBeenCalledWith('filterEq', 'INT32');
      expect(result.matchCount).toBe(2);
      expect([...result.selectionVector]).toEqual([3, 5]);
    });

    it('scalar filter finds no matches', async () => {
      const data = new Int32Array([1, 2, 3]);
      const result = await pd.filterParallel(data, 3, 'filterEq', 'INT32', { value: 99 });

      expect(result.matchCount).toBe(0);
    });

    it('scalar filterGt works correctly', async () => {
      const data = new Int32Array([5, 10, 15, 20, 25]);
      const result = await pd.filterParallel(data, 5, 'filterGt', 'INT32', { value: 12 });

      expect(result.matchCount).toBe(3);
      expect([...result.selectionVector]).toEqual([2, 3, 4]);
    });
  });

  describe('aggregateParallel - worker path', () => {
    it('creates aggregate tasks for workers', async () => {
      const data = new Int32Array(20000);
      await pd.aggregateParallel(data, 20000, 'sum', 'INT32');

      const tasks = pool.execute.mock.calls[0][0];
      for (const t of tasks) {
        expect(t.type).toBe('aggregate');
        expect(t.aggType).toBe('sum');
        expect(t.dataType).toBe('INT32');
      }
    });
  });

  describe('aggregateParallel - fallback path', () => {
    it('computes real sum for small data', async () => {
      const data = new Int32Array([10, 20, 30]);
      const result = await pd.aggregateParallel(data, 3, 'sum', 'INT32');

      expect(pool.execute).not.toHaveBeenCalled();
      expect(result.result).toBe(60);
      expect(result.count).toBe(3);
    });
  });

  describe('compoundFilterParallel - fallback path', () => {
    it('AND of two filters intersects results', async () => {
      const data = new Int32Array([5, 15, 25, 35, 45, 55]);
      const filters = [
        { operation: 'filterGt', value: 10 },
        { operation: 'filterLt', value: 40 },
      ];

      const result = await pd.compoundFilterParallel(data, 6, filters, 'and', 'INT32');

      expect(pool.execute).not.toHaveBeenCalled();
      expect(result.matchCount).toBe(3);
      expect([...result.selectionVector]).toEqual([1, 2, 3]);
    });

    it('OR of two filters unions results', async () => {
      const data = new Int32Array([5, 15, 25, 35, 45, 55]);
      const filters = [
        { operation: 'filterLt', value: 10 },
        { operation: 'filterGt', value: 50 },
      ];

      const result = await pd.compoundFilterParallel(data, 6, filters, 'or', 'INT32');

      expect(pool.execute).not.toHaveBeenCalled();
      expect(result.matchCount).toBe(2);
      expect([...result.selectionVector]).toEqual([0, 5]);
    });

    it('AND with no overlap returns empty', async () => {
      const data = new Int32Array([5, 15, 25]);
      const filters = [
        { operation: 'filterLt', value: 10 },
        { operation: 'filterGt', value: 20 },
      ];

      const result = await pd.compoundFilterParallel(data, 3, filters, 'and', 'INT32');
      expect(result.matchCount).toBe(0);
    });
  });

  describe('compoundFilterParallel - worker path', () => {
    it('sends compound filter tasks to workers', async () => {
      const data = new Int32Array(20000);
      const filters = [
        { operation: 'filterGt', value: 10 },
        { operation: 'filterLt', value: 50 },
      ];

      await pd.compoundFilterParallel(data, 20000, filters, 'and', 'INT32');

      const tasks = pool.execute.mock.calls[0][0];
      expect(tasks[0].type).toBe('filter_compound');
      expect(tasks[0].filters).toEqual(filters);
      expect(tasks[0].combineOp).toBe('and');
    });
  });

  describe('pipelineParallel - worker path', () => {
    it('sends pipeline tasks with stages to workers', async () => {
      const data = new Int32Array(20000);
      const stages = [{ kind: 'filter', operation: 'filterGt', value: 10 }];

      await pd.pipelineParallel(data, 20000, 'INT32', stages);

      const tasks = pool.execute.mock.calls[0][0];
      expect(tasks[0].type).toBe('pipeline');
      expect(tasks[0].stages).toEqual(stages);
      expect(tasks[0].dataType).toBe('INT32');
    });
  });

  describe('pipelineParallel - fallback path', () => {
    it('applies filter stages and returns selection vector', async () => {
      const data = new Int32Array([5, 15, 25, 35]);
      const stages = [{ kind: 'filter', operation: 'filterGt', value: 10 }];

      const result = await pd.pipelineParallel(data, 4, 'INT32', stages);
      expect(pool.execute).not.toHaveBeenCalled();
      expect(result.matchCount).toBe(3);
      expect([...result.selectionVector]).toEqual([1, 2, 3]);
    });

    it('chains multiple filter stages via intersection', async () => {
      const data = new Int32Array([5, 15, 25, 35, 45]);
      const stages = [
        { kind: 'filter', operation: 'filterGt', value: 10 },
        { kind: 'filter', operation: 'filterLt', value: 40 },
      ];

      const result = await pd.pipelineParallel(data, 5, 'INT32', stages);
      expect(result.matchCount).toBe(3);
      expect([...result.selectionVector]).toEqual([1, 2, 3]);
    });

    it('count stage returns filtered count', async () => {
      const data = new Int32Array([5, 15, 25]);
      const stages = [
        { kind: 'filter', operation: 'filterGt', value: 10 },
        { kind: 'count' },
      ];

      const result = await pd.pipelineParallel(data, 3, 'INT32', stages);
      expect(result.aggregates).toBeDefined();
      expect(result.aggregates.count.result).toBe(2);
    });
  });

  describe('projectParallel', () => {
    it('returns null for non-project ops', async () => {
      expect(await pd.projectParallel(new Float64Array(20000), 20000, 'unknownOp')).toBeNull();
    });

    it('returns null below threshold', async () => {
      expect(await pd.projectParallel(new Float64Array(10), 10, 'scalarAddF64', { scalar: 1 })).toBeNull();
    });

    it('returns null with no pool', async () => {
      const pd2 = new ParallelDispatch(null, alloc, dispatch);
      expect(await pd2.projectParallel(new Float64Array(20000), 20000, 'scalarAddF64', { scalar: 1 })).toBeNull();
    });

    it('sends correctly structured project tasks to workers', async () => {
      const data = new Float64Array(20000);
      await pd.projectParallel(data, 20000, 'scalarAddF64', { scalar: 5 });

      const tasks = pool.execute.mock.calls[0][0];
      for (const t of tasks) {
        expect(t.type).toBe('project');
        expect(t.op).toBe('scalarAddF64');
        expect(t.scalar).toBe(5);
        expect(typeof t.dataOffset).toBe('number');
        expect(t.count).toBeGreaterThan(0);
      }
    });

    it('gathers project results into single Float64Array', async () => {
      pool.execute.mockResolvedValueOnce([
        { resultData: new Float64Array([1, 2, 3]), count: 3 },
        { resultData: new Float64Array([4, 5]), count: 2 },
      ]);

      const data = new Float64Array(20000);
      const result = await pd.projectParallel(data, 20000, 'scalarAddF64', { scalar: 0 });

      expect(result).toBeInstanceOf(Float64Array);
      expect(result.length).toBe(20000);
    });

    it('copies dataB into shared memory for vec operations', async () => {
      const data = new Float64Array(20000);
      const dataB = new Float64Array(20000);
      await pd.projectParallel(data, 20000, 'vecAddF64', { dataB });

      const tasks = pool.execute.mock.calls[0][0];
      for (const t of tasks) {
        expect(typeof t.dataBOffset).toBe('number');
      }
    });
  });

  describe('_splitRange', () => {
    it('covers all elements without gaps', () => {
      const morsels = pd._splitRange(100, 4);
      let total = 0;
      for (let i = 0; i < morsels.length; i++) {
        if (i > 0) {
          expect(morsels[i].start).toBe(morsels[i - 1].start + morsels[i - 1].length);
        }
        total += morsels[i].length;
      }
      expect(total).toBe(100);
    });

    it('produces at least workerCount morsels', () => {
      expect(pd._splitRange(1000000, 4).length).toBeGreaterThanOrEqual(4);
    });

    it('handles count smaller than workers', () => {
      const morsels = pd._splitRange(2, 8);
      let total = 0;
      for (const m of morsels) total += m.length;
      expect(total).toBe(2);
    });

    it('single element produces single morsel', () => {
      const morsels = pd._splitRange(1, 4);
      expect(morsels.length).toBe(1);
      expect(morsels[0]).toEqual({ start: 0, length: 1 });
    });
  });

  describe('_gatherSelectionVectors', () => {
    it('merges multiple results preserving order', () => {
      const results = [
        { matchCount: 2, selectionVector: new Uint32Array([0, 1]) },
        { matchCount: 3, selectionVector: new Uint32Array([10, 11, 12]) },
      ];
      const merged = pd._gatherSelectionVectors(results, 20);
      expect(merged.matchCount).toBe(5);
      expect([...merged.selectionVector]).toEqual([0, 1, 10, 11, 12]);
    });

    it('handles empty results', () => {
      const merged = pd._gatherSelectionVectors([{ matchCount: 0 }, { matchCount: 0 }], 100);
      expect(merged.matchCount).toBe(0);
      expect(merged.selectionVector.length).toBe(0);
    });

    it('handles single result', () => {
      const merged = pd._gatherSelectionVectors([{ matchCount: 2, selectionVector: new Uint32Array([3, 7]) }], 10);
      expect(merged.matchCount).toBe(2);
      expect([...merged.selectionVector]).toEqual([3, 7]);
    });
  });

  describe('_mergeAggregates', () => {
    it('sums partial results', () => {
      const merged = pd._mergeAggregates([
        { result: 10, count: 5 },
        { result: 20, count: 5 },
        { result: 30, count: 10 },
      ], 'sum');
      expect(merged.result).toBe(60);
      expect(merged.count).toBe(20);
    });

    it('finds global minimum', () => {
      const merged = pd._mergeAggregates([
        { result: 10, count: 5 },
        { result: 3, count: 5 },
        { result: 7, count: 5 },
      ], 'min');
      expect(merged.result).toBe(3);
    });

    it('finds global maximum', () => {
      const merged = pd._mergeAggregates([
        { result: 10, count: 5 },
        { result: 42, count: 5 },
        { result: 7, count: 5 },
      ], 'max');
      expect(merged.result).toBe(42);
    });

    it('handles count as sum', () => {
      const merged = pd._mergeAggregates([
        { result: 100, count: 100 },
        { result: 200, count: 200 },
      ], 'count');
      expect(merged.result).toBe(300);
    });

    it('returns null for unknown agg type', () => {
      expect(pd._mergeAggregates([{ result: 1, count: 1 }], 'median')).toBeNull();
    });

    it('returns null for empty results', () => {
      expect(pd._mergeAggregates([], 'sum')).toBeNull();
    });

    it('min with negative values', () => {
      const merged = pd._mergeAggregates([
        { result: -5, count: 10 },
        { result: -100, count: 10 },
        { result: 3, count: 10 },
      ], 'min');
      expect(merged.result).toBe(-100);
    });
  });

  describe('_mergePipelineAggregates', () => {
    it('merges pipeline results across multiple workers', () => {
      const results = [
        { aggregates: [{ aggType: 'sum', result: 30, count: 100 }, { aggType: 'min', result: 5, count: 100 }] },
        { aggregates: [{ aggType: 'sum', result: 70, count: 200 }, { aggType: 'min', result: 2, count: 200 }] },
      ];

      const merged = pd._mergePipelineAggregates(results);
      expect(merged.aggregates.sum.result).toBe(100);
      expect(merged.aggregates.sum.count).toBe(300);
      expect(merged.aggregates.min.result).toBe(2);
    });

    it('skips results without aggregates', () => {
      const results = [
        { aggregates: [{ aggType: 'sum', result: 50, count: 10 }] },
        { matchCount: 5 },
      ];

      const merged = pd._mergePipelineAggregates(results);
      expect(merged.aggregates.sum.result).toBe(50);
    });
  });

  describe('_intersectSorted', () => {
    it('intersects two sorted arrays', () => {
      expect([...pd._intersectSorted(new Uint32Array([1, 3, 5, 7, 9]), new Uint32Array([2, 3, 5, 8, 9]))]).toEqual([3, 5, 9]);
    });

    it('returns empty when no overlap', () => {
      expect(pd._intersectSorted(new Uint32Array([1, 3, 5]), new Uint32Array([2, 4, 6])).length).toBe(0);
    });

    it('handles identical arrays', () => {
      expect([...pd._intersectSorted(new Uint32Array([1, 2, 3]), new Uint32Array([1, 2, 3]))]).toEqual([1, 2, 3]);
    });

    it('handles empty arrays', () => {
      expect(pd._intersectSorted(new Uint32Array([]), new Uint32Array([1, 2])).length).toBe(0);
    });
  });

  describe('_unionSorted', () => {
    it('unions two sorted arrays deduplicating', () => {
      expect([...pd._unionSorted(new Uint32Array([1, 3, 5]), new Uint32Array([2, 3, 4]))]).toEqual([1, 2, 3, 4, 5]);
    });

    it('handles disjoint arrays', () => {
      expect([...pd._unionSorted(new Uint32Array([1, 2]), new Uint32Array([10, 20]))]).toEqual([1, 2, 10, 20]);
    });

    it('handles one empty array', () => {
      expect([...pd._unionSorted(new Uint32Array([1, 2, 3]), new Uint32Array([]))]).toEqual([1, 2, 3]);
    });
  });

  describe('_resolveDataPtr', () => {
    it('copies data into shared memory when buffer differs', () => {
      const data = new Int32Array([1, 2, 3, 4]);
      const ptr = pd._resolveDataPtr(data, 4, 4);

      expect(alloc.resetStaging).toHaveBeenCalled();
      expect(alloc.allocStaging).toHaveBeenCalledWith(16);
      expect(typeof ptr).toBe('number');
    });

    it('returns byteOffset when data is already in shared memory', () => {
      const sharedData = new Int32Array(alloc.memory.buffer, 64, 4);
      const ptr = pd._resolveDataPtr(sharedData, 4, 4);
      expect(ptr).toBe(64);
    });
  });
});
