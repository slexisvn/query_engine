import { describe, it, expect, vi } from 'vitest';
import { StatisticsCache } from '../../src/catalog/statistics-cache.js';
import { StatisticsCollector, TableStatistics, ColumnStatistics } from '../../src/catalog/statistics.js';

function makeMockCatalog(tables = {}) {
  const storages = new Map(
    Object.entries(tables).map(([name, rowCount]) => [
      name.toUpperCase(),
      { rowCount: () => rowCount },
    ]),
  );
  return {
    listTables() {
      return [...storages.keys()];
    },
    getTableStorage(name) {
      return storages.get(name.toUpperCase()) || null;
    },
  };
}

function makeFakeStats(rowCount = 100) {
  const columns = new Map();
  columns.set('ID', new ColumnStatistics({ ndv: rowCount, min: 1, max: rowCount }));
  return new TableStatistics(rowCount, columns);
}

describe('StatisticsCache', () => {
  describe('lazy collection', () => {
    it('returns undefined for uncollected table with no storage', () => {
      const cache = new StatisticsCache(makeMockCatalog());
      expect(cache.get('ORDERS')).toBeUndefined();
    });

    it('collects statistics on first ensure() call', async () => {
      const fakeStats = makeFakeStats(500);
      const originalCollect = StatisticsCollector.collect;
      StatisticsCollector.collect = vi.fn().mockResolvedValue(fakeStats);

      try {
        const catalog = makeMockCatalog({ ORDERS: 100 });
        const cache = new StatisticsCache(catalog);

        const result = await cache.ensure('ORDERS');
        expect(result).toBe(fakeStats);
        expect(StatisticsCollector.collect).toHaveBeenCalledTimes(1);
      } finally {
        StatisticsCollector.collect = originalCollect;
      }
    });
  });

  describe('freshness', () => {
    function mutableCatalog() {
      let storage = { rowCount: () => 2 };
      return {
        catalog: {
          listTables: () => ['T'],
          getTableStorage: () => storage,
        },
        replaceStorage(rowCount) {
          storage = { rowCount: () => rowCount };
        },
        growStorage(rowCount) {
          const current = storage;
          current.rowCount = () => rowCount;
        },
      };
    }

    it('re-collects after the table storage is replaced', async () => {
      const originalCollect = StatisticsCollector.collect;
      const harness = mutableCatalog();
      StatisticsCollector.collect = vi.fn(async (storage) => makeFakeStats(storage.rowCount()));

      try {
        const cache = new StatisticsCache(harness.catalog);
        await cache.ensure('T');
        expect(cache.get('T').rowCount).toBe(2);

        harness.replaceStorage(5000);
        expect(cache.get('T')).toBeUndefined();

        await cache.ensure('T');
        expect(cache.get('T').rowCount).toBe(5000);
        expect(StatisticsCollector.collect).toHaveBeenCalledTimes(2);
      } finally {
        StatisticsCollector.collect = originalCollect;
      }
    });

    it('re-collects after rows are appended to the same storage', async () => {
      const originalCollect = StatisticsCollector.collect;
      const harness = mutableCatalog();
      StatisticsCollector.collect = vi.fn(async (storage) => makeFakeStats(storage.rowCount()));

      try {
        const cache = new StatisticsCache(harness.catalog);
        await cache.ensure('T');

        harness.growStorage(900);
        expect(cache.get('T')).toBeUndefined();

        await cache.ensure('T');
        expect(cache.get('T').rowCount).toBe(900);
      } finally {
        StatisticsCollector.collect = originalCollect;
      }
    });

    it('keeps serving stats while the data behind them is unchanged', async () => {
      const originalCollect = StatisticsCollector.collect;
      const harness = mutableCatalog();
      StatisticsCollector.collect = vi.fn(async (storage) => makeFakeStats(storage.rowCount()));

      try {
        const cache = new StatisticsCache(harness.catalog);
        await cache.ensure('T');
        await cache.ensure('T');
        await cache.ensure('T');
        expect(StatisticsCollector.collect).toHaveBeenCalledTimes(1);
      } finally {
        StatisticsCollector.collect = originalCollect;
      }
    });

    it('keeps manually supplied stats that describe no storage', () => {
      const cache = new StatisticsCache({ listTables: () => [], getTableStorage: () => null });
      cache.set('MANUAL', makeFakeStats(42));
      expect(cache.get('MANUAL').rowCount).toBe(42);
    });
  });

  describe('scoped collection', () => {
    it('collects only the tables it was asked for', async () => {
      const originalCollect = StatisticsCollector.collect;
      StatisticsCollector.collect = vi.fn().mockResolvedValue(makeFakeStats(10));

      try {
        const cache = new StatisticsCache(makeMockCatalog({ ORDERS: 100, LINEITEM: 100, PART: 100 }));
        await cache.ensureFor(['ORDERS']);

        expect(StatisticsCollector.collect).toHaveBeenCalledTimes(1);
        expect(cache.get('ORDERS')).toBeDefined();
        expect(cache.get('LINEITEM')).toBeUndefined();
        expect(cache.get('PART')).toBeUndefined();
      } finally {
        StatisticsCollector.collect = originalCollect;
      }
    });

    it('advances its generation only when an entry actually lands', async () => {
      const originalCollect = StatisticsCollector.collect;
      StatisticsCollector.collect = vi.fn().mockResolvedValue(makeFakeStats(10));

      try {
        const cache = new StatisticsCache(makeMockCatalog({ ORDERS: 100 }));
        const initial = cache.generation;

        await cache.ensureFor(['ORDERS']);
        const afterCollect = cache.generation;
        expect(afterCollect).toBeGreaterThan(initial);

        await cache.ensureFor(['ORDERS']);
        expect(cache.generation).toBe(afterCollect);

        await cache.ensureFor(['MISSING']);
        expect(cache.generation).toBe(afterCollect);
      } finally {
        StatisticsCollector.collect = originalCollect;
      }
    });
  });

  describe('cache hit on second access', () => {
    it('does not re-collect when entry is valid', async () => {
      const fakeStats = makeFakeStats(200);
      const originalCollect = StatisticsCollector.collect;
      StatisticsCollector.collect = vi.fn().mockResolvedValue(fakeStats);

      try {
        const catalog = makeMockCatalog({ T: 100 });
        const cache = new StatisticsCache(catalog);

        await cache.ensure('T');
        await cache.ensure('T');
        expect(StatisticsCollector.collect).toHaveBeenCalledTimes(1);
      } finally {
        StatisticsCollector.collect = originalCollect;
      }
    });
  });

  describe('invalidation forces re-collection', () => {
    it('returns undefined after invalidation until re-ensured', async () => {
      const fakeStats = makeFakeStats();
      const originalCollect = StatisticsCollector.collect;
      StatisticsCollector.collect = vi.fn().mockResolvedValue(fakeStats);

      try {
        const catalog = makeMockCatalog({ T: 100 });
        const cache = new StatisticsCache(catalog);

        await cache.ensure('T');
        expect(cache.has('T')).toBe(true);

        cache.invalidate('T');
        expect(cache.has('T')).toBe(false);

        await cache.ensure('T');
        expect(cache.has('T')).toBe(true);
        expect(StatisticsCollector.collect).toHaveBeenCalledTimes(2);
      } finally {
        StatisticsCollector.collect = originalCollect;
      }
    });
  });

  describe('Map-compatible interface', () => {
    it('set() and get() work for manual entries', () => {
      const cache = new StatisticsCache(makeMockCatalog());
      const stats = makeFakeStats(300);

      cache.set('MANUAL', stats);
      expect(cache.get('MANUAL')).toBe(stats);
      expect(cache.has('MANUAL')).toBe(true);
    });

    it('size reflects valid entry count', () => {
      const cache = new StatisticsCache(makeMockCatalog());
      expect(cache.size).toBe(0);

      cache.set('A', makeFakeStats());
      cache.set('B', makeFakeStats());
      expect(cache.size).toBe(2);

      cache.invalidate('A');
      expect(cache.size).toBe(1);
    });

    it('values() yields only valid entries', () => {
      const cache = new StatisticsCache(makeMockCatalog());
      const s1 = makeFakeStats(10);
      const s2 = makeFakeStats(20);

      cache.set('X', s1);
      cache.set('Y', s2);
      cache.invalidate('X');

      const vals = [...cache.values()];
      expect(vals).toHaveLength(1);
      expect(vals[0]).toBe(s2);
    });

    it('entries() yields key-value pairs for valid entries', () => {
      const cache = new StatisticsCache(makeMockCatalog());
      cache.set('K1', makeFakeStats(5));
      cache.set('K2', makeFakeStats(10));

      const entries = [...cache.entries()];
      expect(entries).toHaveLength(2);
      expect(entries[0][0]).toBe('K1');
      expect(entries[1][0]).toBe('K2');
    });

    it('toMap() returns a plain Map snapshot', () => {
      const cache = new StatisticsCache(makeMockCatalog());
      cache.set('T1', makeFakeStats());
      cache.set('T2', makeFakeStats());

      const map = cache.toMap();
      expect(map instanceof Map).toBe(true);
      expect(map.size).toBe(2);
      expect(map.has('T1')).toBe(true);
    });

    it('Symbol.iterator works with for-of', () => {
      const cache = new StatisticsCache(makeMockCatalog());
      cache.set('Z', makeFakeStats());

      const collected = [];
      for (const [key, val] of cache) {
        collected.push(key);
      }
      expect(collected).toEqual(['Z']);
    });
  });
});
