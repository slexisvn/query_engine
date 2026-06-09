import { describe, it, expect } from 'vitest';
import { HashPartitionStrategy, RangePartitionStrategy, RoundRobinPartitionStrategy, murmur3 } from '../../../src/distributed/partition/partition-strategy.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DataType } from '../../../src/storage/data-type.js';

function makeIntChunk(values) {
  const col = new Column(DataType.INT32, values.length);
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

function makeMultiColChunk(ids, names) {
  const idCol = new Column(DataType.INT32, ids.length);
  const nameCol = new Column(DataType.VARCHAR, names.length);
  for (let i = 0; i < ids.length; i++) {
    idCol.set(i, ids[i]);
    nameCol.set(i, names[i]);
  }
  idCol.length = ids.length;
  nameCol.length = names.length;
  return new DataChunk([idCol, nameCol], ids.length);
}

describe('murmur3', () => {
  it('produces consistent hashes for same input', () => {
    const h1 = murmur3('hello', 0);
    const h2 = murmur3('hello', 0);
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = murmur3('hello', 0);
    const h2 = murmur3('world', 0);
    expect(h1).not.toBe(h2);
  });

  it('returns unsigned 32-bit integer', () => {
    const h = murmur3('test', 0);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });

  it('different seeds produce different hashes', () => {
    const h1 = murmur3('hello', 0);
    const h2 = murmur3('hello', 42);
    expect(h1).not.toBe(h2);
  });
});

describe('HashPartitionStrategy', () => {
  const strategy = new HashPartitionStrategy();

  it('partitions key deterministically', () => {
    const p1 = strategy.partitionFor(42, 8);
    const p2 = strategy.partitionFor(42, 8);
    expect(p1).toBe(p2);
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p1).toBeLessThan(8);
  });

  it('distributes 1000 keys across all 8 partitions', () => {
    const counts = new Map();
    for (let i = 0; i < 1000; i++) {
      const pid = strategy.partitionFor(i, 8);
      counts.set(pid, (counts.get(pid) || 0) + 1);
    }
    expect(counts.size).toBe(8);

    for (const [pid, count] of counts) {
      expect(pid).toBeGreaterThanOrEqual(0);
      expect(pid).toBeLessThan(8);
      expect(count).toBeGreaterThan(50);
      expect(count).toBeLessThan(250);
    }
  });

  it('distribution is reasonably uniform across 16 partitions', () => {
    const n = 10000;
    const partCount = 16;
    const counts = new Array(partCount).fill(0);
    for (let i = 0; i < n; i++) {
      counts[strategy.partitionFor(i, partCount)]++;
    }

    const expected = n / partCount;
    for (const count of counts) {
      expect(count).toBeGreaterThan(expected * 0.3);
      expect(count).toBeLessThan(expected * 2.0);
    }
  });

  it('partitions a chunk and each row lands in the correct bucket', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80];
    const chunk = makeIntChunk(values);
    const partitioned = strategy.partitionChunk(chunk, 0, 4);

    let totalRows = 0;
    const allValues = new Set();
    for (const [pid, partChunk] of partitioned) {
      expect(pid).toBeGreaterThanOrEqual(0);
      expect(pid).toBeLessThan(4);
      for (let i = 0; i < partChunk.size; i++) {
        const val = partChunk.columns[0].get(i);
        allValues.add(val);

        const expectedPid = strategy.partitionFor(val, 4);
        expect(pid).toBe(expectedPid);
      }
      totalRows += partChunk.size;
    }

    expect(totalRows).toBe(8);
    expect(allValues.size).toBe(8);
  });

  it('preserves all columns in partitioned chunks', () => {
    const chunk = makeMultiColChunk([1, 2, 3], ['a', 'b', 'c']);
    const partitioned = strategy.partitionChunk(chunk, 0, 2);

    const allPairs = [];
    for (const [_, partChunk] of partitioned) {
      expect(partChunk.columns.length).toBe(2);
      for (let i = 0; i < partChunk.size; i++) {
        allPairs.push([partChunk.columns[0].get(i), partChunk.columns[1].get(i)]);
      }
    }

    allPairs.sort((a, b) => a[0] - b[0]);
    expect(allPairs).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
  });

  it('handles null keys by mapping to partition 0', () => {
    const p = strategy.partitionFor(null, 8);
    expect(p).toBe(0);
  });

  it('handles bigint keys', () => {
    const p = strategy.partitionFor(100n, 8);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(8);
  });

  it('same value always maps to same partition regardless of other data', () => {
    const pid1 = strategy.partitionFor(999, 16);
    const pid2 = strategy.partitionFor(999, 16);
    expect(pid1).toBe(pid2);
  });
});

describe('RangePartitionStrategy', () => {
  const strategy = new RangePartitionStrategy([10, 20, 30]);

  it('places values in correct range partition via binary search', () => {
    expect(strategy.partitionFor(5)).toBe(0);
    expect(strategy.partitionFor(10)).toBe(1);
    expect(strategy.partitionFor(15)).toBe(1);
    expect(strategy.partitionFor(20)).toBe(2);
    expect(strategy.partitionFor(25)).toBe(2);
    expect(strategy.partitionFor(30)).toBe(3);
    expect(strategy.partitionFor(99)).toBe(3);
  });

  it('boundary values land in the correct partition', () => {
    expect(strategy.partitionFor(9)).toBe(0);
    expect(strategy.partitionFor(10)).toBe(1);
    expect(strategy.partitionFor(19)).toBe(1);
    expect(strategy.partitionFor(20)).toBe(2);
    expect(strategy.partitionFor(29)).toBe(2);
    expect(strategy.partitionFor(30)).toBe(3);
  });

  it('handles null values', () => {
    expect(strategy.partitionFor(null)).toBe(0);
  });

  it('partitions a chunk and each row lands in the correct range', () => {
    const values = [5, 15, 25, 35];
    const chunk = makeIntChunk(values);
    const partitioned = strategy.partitionChunk(chunk, 0, 4);

    let totalRows = 0;
    for (const [pid, partChunk] of partitioned) {
      for (let i = 0; i < partChunk.size; i++) {
        const val = partChunk.columns[0].get(i);
        expect(strategy.partitionFor(val)).toBe(pid);
      }
      totalRows += partChunk.size;
    }
    expect(totalRows).toBe(4);
  });

  it('binary search works with 1000 boundaries', () => {
    const bounds = Array.from({ length: 1000 }, (_, i) => (i + 1) * 10);
    const strat = new RangePartitionStrategy(bounds);

    expect(strat.partitionFor(5)).toBe(0);
    expect(strat.partitionFor(15)).toBe(1);
    expect(strat.partitionFor(5555)).toBe(555);
    expect(strat.partitionFor(10005)).toBe(1000);
  });

  it('exposes boundaries', () => {
    expect(strategy.boundaries).toEqual([10, 20, 30]);
  });

  it('negative values go to partition 0', () => {
    expect(strategy.partitionFor(-100)).toBe(0);
  });
});

describe('RoundRobinPartitionStrategy', () => {
  const strategy = new RoundRobinPartitionStrategy();

  it('distributes rows in modular order', () => {
    expect(strategy.partitionFor(0, 3)).toBe(0);
    expect(strategy.partitionFor(1, 3)).toBe(1);
    expect(strategy.partitionFor(2, 3)).toBe(2);
    expect(strategy.partitionFor(3, 3)).toBe(0);
    expect(strategy.partitionFor(4, 3)).toBe(1);
  });

  it('partitions chunk with perfectly even distribution', () => {
    const chunk = makeIntChunk([10, 20, 30, 40, 50, 60]);
    const partitioned = strategy.partitionChunk(chunk, 0, 3);

    let totalRows = 0;
    const bucketSizes = [];
    for (const [_, partChunk] of partitioned) {
      bucketSizes.push(partChunk.size);
      totalRows += partChunk.size;
    }
    expect(totalRows).toBe(6);
    expect(bucketSizes.every(s => s === 2)).toBe(true);
  });

  it('handles uneven distribution', () => {
    const chunk = makeIntChunk([1, 2, 3, 4, 5, 6, 7]);
    const partitioned = strategy.partitionChunk(chunk, 0, 3);

    let totalRows = 0;
    for (const [_, partChunk] of partitioned) {
      totalRows += partChunk.size;
    }
    expect(totalRows).toBe(7);
  });
});
