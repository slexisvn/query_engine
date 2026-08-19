import { ColumnStatistics, TableStatistics, EquiDepthHistogram, StatisticsCollector } from '../../src/catalog/statistics.js';

describe('ColumnStatistics', () => {
  it('stores all properties', () => {
    const cs = new ColumnStatistics({ ndv: 100, min: 1, max: 1000, nullFraction: 0.05, avgWidth: 4 });
    expect(cs.ndv).toBe(100);
    expect(cs.min).toBe(1);
    expect(cs.max).toBe(1000);
    expect(cs.nullFraction).toBe(0.05);
    expect(cs.avgWidth).toBe(4);
    expect(cs.histogram).toBeNull();
    expect(cs.mcv).toBeNull();
  });

  it('has sane defaults', () => {
    const cs = new ColumnStatistics();
    expect(cs.ndv).toBe(0);
    expect(cs.min).toBeNull();
    expect(cs.max).toBeNull();
    expect(cs.nullFraction).toBe(0);
    expect(cs.avgWidth).toBe(8);
  });
});

describe('TableStatistics', () => {
  it('stores rowCount and column stats', () => {
    const colStats = new Map();
    colStats.set('ID', new ColumnStatistics({ avgWidth: 4 }));
    colStats.set('NAME', new ColumnStatistics({ avgWidth: 32 }));
    const ts = new TableStatistics(1000, colStats);

    expect(ts.rowCount).toBe(1000);
    expect(ts.columnStats.size).toBe(2);
  });

  describe('getColumnStats / setColumnStats', () => {
    it('retrieves by uppercase key', () => {
      const ts = new TableStatistics(100);
      ts.setColumnStats('name', new ColumnStatistics({ ndv: 50 }));
      expect(ts.getColumnStats('NAME').ndv).toBe(50);
      expect(ts.getColumnStats('name').ndv).toBe(50);
    });

    it('returns null for missing column', () => {
      expect(new TableStatistics(100).getColumnStats('nope')).toBeNull();
    });
  });

  describe('avgRowWidth', () => {
    it('sums avgWidth of all columns', () => {
      const ts = new TableStatistics(100);
      ts.setColumnStats('A', new ColumnStatistics({ avgWidth: 4 }));
      ts.setColumnStats('B', new ColumnStatistics({ avgWidth: 8 }));
      ts.setColumnStats('C', new ColumnStatistics({ avgWidth: 20 }));
      expect(ts.avgRowWidth).toBe(32);
    });

    it('defaults to 8 per column when avgWidth is missing', () => {
      const ts = new TableStatistics(100);
      ts.setColumnStats('A', new ColumnStatistics());
      expect(ts.avgRowWidth).toBe(8);
    });

    it('returns 64 when no columns', () => {
      expect(new TableStatistics(100).avgRowWidth).toBe(64);
    });
  });
});

describe('EquiDepthHistogram', () => {
  it('constructs with boundaries and computes rowsPerBucket', () => {
    const h = new EquiDepthHistogram([10, 20, 30, 40], 100);
    expect(h.numBuckets).toBe(4);
    expect(h.numRows).toBe(100);
    expect(h.rowsPerBucket).toBe(25);
  });

  describe('estimateLessThan', () => {
    it('returns 1.0 for value beyond all boundaries', () => {
      const h = new EquiDepthHistogram([10, 20, 30], 90);
      expect(h.estimateLessThan(100)).toBe(1.0);
    });

    it('returns fraction < 1 for value in middle', () => {
      const h = new EquiDepthHistogram([10, 20, 30, 40, 50], 100);
      const frac = h.estimateLessThan(25);
      expect(frac).toBeGreaterThan(0);
      expect(frac).toBeLessThan(1);
    });

    it('returns small fraction for value near start', () => {
      const h = new EquiDepthHistogram([10, 20, 30, 40, 50], 100);
      const frac = h.estimateLessThan(5);
      expect(frac).toBeGreaterThanOrEqual(0);
      expect(frac).toBeLessThanOrEqual(0.5);
    });

    it('returns 0.5 for empty histogram', () => {
      const h = new EquiDepthHistogram([], 0);
      expect(h.estimateLessThan(10)).toBe(0.5);
    });

    it('returns 0.5 for non-numeric value', () => {
      const h = new EquiDepthHistogram([10, 20, 30], 90);
      expect(h.estimateLessThan('abc')).toBe(0.5);
    });

    it('handles null value', () => {
      const h = new EquiDepthHistogram([10, 20], 100);
      expect(h.estimateLessThan(null)).toBe(0.5);
    });

    it('monotonically increases with larger values', () => {
      const h = new EquiDepthHistogram([10, 20, 30, 40, 50], 100);
      const f1 = h.estimateLessThan(15);
      const f2 = h.estimateLessThan(25);
      const f3 = h.estimateLessThan(35);
      expect(f2).toBeGreaterThanOrEqual(f1);
      expect(f3).toBeGreaterThanOrEqual(f2);
    });
  });

  describe('estimateRange', () => {
    it('returns positive fraction for valid range', () => {
      const h = new EquiDepthHistogram([10, 20, 30, 40, 50], 100);
      const frac = h.estimateRange(15, 35);
      expect(frac).toBeGreaterThan(0);
      expect(frac).toBeLessThanOrEqual(1);
    });

    it('returns at least 0.001 even for degenerate range', () => {
      const h = new EquiDepthHistogram([10, 20, 30], 90);
      expect(h.estimateRange(5, 5)).toBeGreaterThanOrEqual(0.001);
    });

    it('wider range gives larger fraction', () => {
      const h = new EquiDepthHistogram([10, 20, 30, 40, 50], 100);
      const narrow = h.estimateRange(20, 25);
      const wide = h.estimateRange(10, 45);
      expect(wide).toBeGreaterThanOrEqual(narrow);
    });
  });

  describe('per-bucket statistics', () => {
    it('round-trips bucketCounts and bucketDistincts via bucketInfo', () => {
      const h = new EquiDepthHistogram([10, 20, 30], 90, [5, 8, 7], [1, 6, 7]);
      const info = h.bucketInfo();
      expect(info.boundaries).toEqual([10, 20, 30]);
      expect(info.bucketCounts).toEqual([5, 8, 7]);
      expect(info.bucketDistincts).toEqual([1, 6, 7]);
      expect(h.totalCount).toBe(20);
    });

    it('defaults per-bucket fields to null when not provided', () => {
      const h = new EquiDepthHistogram([10, 20], 50);
      expect(h.bucketInfo().bucketCounts).toBeNull();
      expect(h.bucketInfo().bucketDistincts).toBeNull();
      expect(h.totalCount).toBeNull();
    });

    it('collector builds per-bucket distinct counts that expose skew', () => {
      const hot = Array.from({ length: 24 }, () => 0);
      const tail = [];
      for (let v = 1; v <= 24; v++) tail.push(v);
      const hist = StatisticsCollector._buildHistogram([...hot, ...tail], 48);

      expect(hist.bucketCounts).not.toBeNull();
      expect(hist.bucketDistincts).not.toBeNull();
      expect(hist.bucketCounts.reduce((a, b) => a + b, 0)).toBe(48);
      const firstBucketDistinct = hist.bucketDistincts[0];
      const lastBucketDistinct = hist.bucketDistincts[hist.numBuckets - 1];
      expect(firstBucketDistinct).toBeLessThan(lastBucketDistinct);
    });
  });
});

describe('StatisticsCollector', () => {
  function mockTable(rows, schema) {
    return {
      rowCount: () => rows.length,
      getSchema: () => schema,
      getColumnIndex: (name) => schema.findIndex(c => c.name.toUpperCase() === name.toUpperCase()),
      scan: async function* () {
        yield {
          size: rows.length,
          getValue: (rowIdx, colIdx) => rows[rowIdx][colIdx],
        };
      },
    };
  }

  it('collects stats for numeric column', async () => {
    const schema = [{ name: 'VAL', dataType: 'INT32' }];
    const rows = [[1], [2], [3], [4], [5], [null], [3], [2]];
    const table = mockTable(rows, schema);

    const stats = await StatisticsCollector.collect(table);
    expect(stats.rowCount).toBe(8);

    const colStats = stats.getColumnStats('VAL');
    expect(colStats).not.toBeNull();
    expect(colStats.ndv).toBe(5);
    expect(colStats.min).toBe(1);
    expect(colStats.max).toBe(5);
    expect(colStats.nullFraction).toBeCloseTo(1 / 8, 5);
    expect(colStats.histogram).not.toBeNull();
  });

  it('collects stats for varchar column', async () => {
    const schema = [{ name: 'NAME', dataType: 'VARCHAR' }];
    const rows = [['alice'], ['bob'], ['alice'], [null], ['charlie']];
    const table = mockTable(rows, schema);

    const stats = await StatisticsCollector.collect(table);
    const colStats = stats.getColumnStats('NAME');
    expect(colStats.ndv).toBe(3);
    expect(colStats.min).toBe('alice');
    expect(colStats.max).toBe('charlie');
    expect(colStats.nullFraction).toBeCloseTo(1 / 5, 5);
    expect(colStats.histogram).toBeNull();
  });

  it('builds MCV with correct frequencies', async () => {
    const schema = [{ name: 'X', dataType: 'INT32' }];
    const rows = [[1], [1], [1], [2], [2], [3]];
    const table = mockTable(rows, schema);

    const stats = await StatisticsCollector.collect(table);
    const mcv = stats.getColumnStats('X').mcv;
    expect(mcv).not.toBeNull();
    expect(mcv.values[0]).toBe('1');
    expect(mcv.frequencies[0]).toBeCloseTo(3 / 6, 5);
    expect(mcv.values[1]).toBe('2');
    expect(mcv.frequencies[1]).toBeCloseTo(2 / 6, 5);
  });

  it('handles all-null column', async () => {
    const schema = [{ name: 'X', dataType: 'INT32' }];
    const rows = [[null], [null], [null]];
    const table = mockTable(rows, schema);

    const stats = await StatisticsCollector.collect(table);
    const colStats = stats.getColumnStats('X');
    expect(colStats.ndv).toBe(0);
    expect(colStats.nullFraction).toBe(1);
    expect(colStats.min).toBeNull();
    expect(colStats.max).toBeNull();
    expect(colStats.histogram).toBeNull();
    expect(colStats.mcv).toBeNull();
  });

  it('handles empty table', async () => {
    const schema = [{ name: 'X', dataType: 'INT32' }];
    const table = mockTable([], schema);

    const stats = await StatisticsCollector.collect(table);
    expect(stats.rowCount).toBe(0);
    const colStats = stats.getColumnStats('X');
    expect(colStats.ndv).toBe(0);
    expect(colStats.nullFraction).toBe(0);
  });

  it('collects stats for multiple columns', async () => {
    const schema = [
      { name: 'ID', dataType: 'INT32' },
      { name: 'NAME', dataType: 'VARCHAR' },
    ];
    const rows = [[1, 'alice'], [2, 'bob'], [3, 'charlie']];
    const table = mockTable(rows, schema);

    const stats = await StatisticsCollector.collect(table);
    expect(stats.getColumnStats('ID').ndv).toBe(3);
    expect(stats.getColumnStats('NAME').ndv).toBe(3);
  });

  it('builds histogram with correct number of buckets', async () => {
    const schema = [{ name: 'X', dataType: 'INT32' }];
    const rows = Array.from({ length: 100 }, (_, i) => [i]);
    const table = mockTable(rows, schema);

    const stats = await StatisticsCollector.collect(table);
    const h = stats.getColumnStats('X').histogram;
    expect(h).not.toBeNull();
    expect(h.numBuckets).toBeGreaterThan(0);
    expect(h.numBuckets).toBeLessThanOrEqual(64);
    expect(h.boundaries[h.boundaries.length - 1]).toBe(99);
  });
});
