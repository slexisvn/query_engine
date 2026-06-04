import { describe, it, expect } from 'vitest';
import { StatisticsCollector, EquiDepthHistogram, ColumnStatistics } from '../../src/catalog/statistics.js';
import { DefaultCardinalityEstimator } from '../../src/optimizer/dphyp/cardinality.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

describe('EquiDepthHistogram', () => {
  it('estimates less-than fraction for values in range', () => {
    const boundaries = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const hist = new EquiDepthHistogram(boundaries, 1000);

    const frac50 = hist.estimateLessThan(50);
    expect(frac50).toBeGreaterThan(0.3);
    expect(frac50).toBeLessThan(0.7);

    const frac10 = hist.estimateLessThan(10);
    expect(frac10).toBeLessThan(0.2);

    const frac100 = hist.estimateLessThan(100);
    expect(frac100).toBeGreaterThan(0.8);
  });

  it('estimates range selectivity', () => {
    const boundaries = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const hist = new EquiDepthHistogram(boundaries, 1000);

    const sel = hist.estimateRange(20, 40);
    expect(sel).toBeGreaterThan(0.1);
    expect(sel).toBeLessThan(0.4);
  });
});

describe('StatisticsCollector', () => {
  it('collects histogram and MCV for numeric data', async () => {
    const mockTable = {
      getSchema: () => [
        { name: 'ID', dataType: 'INT32' },
        { name: 'NAME', dataType: 'VARCHAR' },
      ],
      getColumnIndex: (name) => name === 'ID' ? 0 : 1,
      rowCount: () => 100,
      scan: async function* () {
        yield {
          size: 100,
          getValue: (row, col) => {
            if (col === 0) return row + 1;
            if (col === 1) return row < 50 ? 'Alice' : 'Bob';
            return null;
          },
        };
      },
    };

    const stats = await StatisticsCollector.collect(mockTable);
    expect(stats.rowCount).toBe(100);

    const idStats = stats.getColumnStats('ID');
    expect(idStats).not.toBeNull();
    expect(idStats.ndv).toBe(100);
    expect(idStats.min).toBe(1);
    expect(idStats.max).toBe(100);
    expect(idStats.histogram).not.toBeNull();
    expect(idStats.histogram.numBuckets).toBeGreaterThan(0);

    const nameStats = stats.getColumnStats('NAME');
    expect(nameStats).not.toBeNull();
    expect(nameStats.ndv).toBe(2);
    expect(nameStats.mcv).not.toBeNull();
    expect(nameStats.mcv.values).toContain('Alice');
    expect(nameStats.mcv.values).toContain('Bob');
    expect(nameStats.mcv.frequencies[0]).toBeCloseTo(0.5, 1);
  });
});

describe('Cardinality Estimation with MCV', () => {
  it('uses MCV frequency for equality selectivity', () => {
    const stats = new Map();
    stats.set('T', {
      rowCount: 1000,
      columnStats: new Map([
        ['STATUS', new ColumnStatistics({
          ndv: 3,
          nullFraction: 0,
          mcv: {
            values: ['ACTIVE', 'INACTIVE', 'PENDING'],
            frequencies: [0.7, 0.2, 0.1],
          },
        })],
      ]),
    });

    const est = new DefaultCardinalityEstimator(stats);
    const pred = {
      kind: BoundExprKind.BINARY, op: '=',
      left: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: 'STATUS', columnIndex: 0 },
      right: { kind: BoundExprKind.LITERAL, value: 'ACTIVE', dataType: 'VARCHAR' },
    };

    const sel = est.estimateSelectivity(pred);
    expect(sel).toBeCloseTo(0.7, 1);
  });

  it('uses uniform distribution for non-MCV values', () => {
    const stats = new Map();
    stats.set('T', {
      rowCount: 1000,
      columnStats: new Map([
        ['STATUS', new ColumnStatistics({
          ndv: 100,
          nullFraction: 0,
          mcv: {
            values: ['ACTIVE'],
            frequencies: [0.5],
          },
        })],
      ]),
    });

    const est = new DefaultCardinalityEstimator(stats);
    const pred = {
      kind: BoundExprKind.BINARY, op: '=',
      left: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: 'STATUS', columnIndex: 0 },
      right: { kind: BoundExprKind.LITERAL, value: 'UNKNOWN_VALUE', dataType: 'VARCHAR' },
    };

    const sel = est.estimateSelectivity(pred);
    expect(sel).toBeCloseTo(0.01, 2);
  });

  it('uses histogram for range selectivity', () => {
    const boundaries = [];
    for (let i = 1; i <= 20; i++) boundaries.push(i * 50);
    const hist = new EquiDepthHistogram(boundaries, 1000);

    const stats = new Map();
    stats.set('T', {
      rowCount: 1000,
      columnStats: new Map([
        ['VAL', new ColumnStatistics({
          ndv: 1000, min: 1, max: 1000,
          histogram: hist,
        })],
      ]),
    });

    const est = new DefaultCardinalityEstimator(stats);
    const pred = {
      kind: BoundExprKind.BINARY, op: '<',
      left: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: 'VAL', columnIndex: 0 },
      right: { kind: BoundExprKind.LITERAL, value: 500, dataType: 'INT32' },
    };

    const sel = est.estimateSelectivity(pred);
    expect(sel).toBeGreaterThan(0.3);
    expect(sel).toBeLessThan(0.7);
  });
});
