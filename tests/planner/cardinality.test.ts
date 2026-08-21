import { describe, it, expect } from 'vitest';
import { DefaultCardinalityEstimator } from '../../src/planner/cardinality.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { PlanNodeType, JoinType } from '../../src/planner/logical-plan.js';
import { EquiDepthHistogram, createMcv } from '../../src/catalog/statistics.js';
import { Binder } from '../../src/binder/binder.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { FunctionRegistry } from '../../src/catalog/function-registry.js';
import { DataType } from '../../src/storage/data-type.js';
import { parse } from '../../src/parser/parser.js';
import { Config } from '../../src/config.js';

function makeColRef(table, column) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column };
}

function makeLiteral(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function makeBinary(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right };
}

function makeStats(overrides = {}) {
  const stats = new Map();
  const columns = new Map();
  columns.set('ID', { ndv: 1000, min: 1, max: 1000, nullFraction: 0 });
  columns.set('STATUS', { ndv: 5, min: null, max: null, nullFraction: 0.02 });
  columns.set('AMOUNT', { ndv: 500, min: 0, max: 10000, nullFraction: 0 });
  stats.set('ORDERS', { rowCount: 10000, columnStats: columns, ...overrides });
  return stats;
}

describe('DefaultCardinalityEstimator', () => {
  describe('estimateScan', () => {
    it('returns row count from statistics', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimateScan('orders')).toBe(10000);
    });

    it('returns default 1000 when table not found', () => {
      const est = new DefaultCardinalityEstimator(new Map());
      expect(est.estimateScan('unknown')).toBe(1000);
    });
  });

  describe('estimatePlan', () => {
    it('handles SCAN node', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimatePlan({ type: PlanNodeType.SCAN, table: 'orders' })).toBe(10000);
    });

    it('handles FILTER node with equality predicate', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const condition = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('active'));
      const plan = {
        type: PlanNodeType.FILTER,
        condition,
        children: [{ type: PlanNodeType.SCAN, table: 'orders' }],
      };
      const result = est.estimatePlan(plan);
      expect(result).toBeLessThan(10000);
      expect(result).toBeGreaterThan(0);
    });

    it('handles LIMIT node', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const plan = {
        type: PlanNodeType.LIMIT,
        count: 10,
        children: [{ type: PlanNodeType.SCAN, table: 'orders' }],
      };
      expect(est.estimatePlan(plan)).toBe(10);
    });

    it('LIMIT does not exceed child cardinality', () => {
      const stats = new Map();
      stats.set('TINY', { rowCount: 3, columnStats: new Map() });
      const est = new DefaultCardinalityEstimator(stats);
      const plan = {
        type: PlanNodeType.LIMIT,
        count: 100,
        children: [{ type: PlanNodeType.SCAN, table: 'TINY' }],
      };
      expect(est.estimatePlan(plan)).toBe(3);
    });

    it('handles PROJECT/SORT/DISTINCT as pass-through', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      for (const type of [PlanNodeType.PROJECT, PlanNodeType.SORT, PlanNodeType.DISTINCT]) {
        const plan = {
          type,
          children: [{ type: PlanNodeType.SCAN, table: 'orders' }],
        };
        expect(est.estimatePlan(plan)).toBe(10000);
      }
    });

    it('handles EMPTY node', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimatePlan({ type: PlanNodeType.EMPTY })).toBe(0);
    });

    it('returns 1000 for null node', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimatePlan(null)).toBe(1000);
    });

    it('handles CROSS join', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.CROSS,
        children: [
          { type: PlanNodeType.SCAN, table: 'orders' },
          { type: PlanNodeType.SCAN, table: 'orders' },
        ],
      };
      expect(est.estimatePlan(plan)).toBe(10000 * 10000);
    });
  });

  describe('estimateJoin', () => {
    it('returns cartesian product when no condition', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimateJoin(100, 200, null)).toBe(100 * 200);
    });

    it('reduces cardinality with equi-join on high-NDV columns', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const cond = makeBinary(makeColRef('ORDERS', 'ID'), '=', makeColRef('ORDERS', 'ID'));
      const result = est.estimateJoin(10000, 10000, cond);
      expect(result).toBeLessThan(10000 * 10000);
    });

    it('multi-key join produces tighter estimate than single-key', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const cond1 = makeBinary(makeColRef('ORDERS', 'ID'), '=', makeColRef('ORDERS', 'ID'));
      const cond2 = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeColRef('ORDERS', 'STATUS'));
      const combined = makeBinary(cond1, 'AND', cond2);
      const singleResult = est.estimateJoin(10000, 10000, cond1);
      const doubleResult = est.estimateJoin(10000, 10000, combined);
      expect(doubleResult).toBeLessThan(singleResult);
    });
  });

  describe('estimateLeftJoin', () => {
    it('returns at least left cardinality', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const cond = makeBinary(makeColRef('ORDERS', 'ID'), '=', makeColRef('ORDERS', 'ID'));
      const result = est.estimateLeftJoin(1000, 500, cond);
      expect(result).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('estimateSemiJoin', () => {
    it('returns half of left when no condition', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimateSemiJoin(1000, 500, null)).toBe(500);
    });

    it('uses NDV ratio with equi-predicate', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const cond = makeBinary(makeColRef('ORDERS', 'ID'), '=', makeColRef('ORDERS', 'STATUS'));
      const result = est.estimateSemiJoin(1000, 500, cond);
      expect(result).toBeLessThanOrEqual(1000);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('estimateAntiJoin', () => {
    it('returns complement of semi join', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const cond = makeBinary(makeColRef('ORDERS', 'ID'), '=', makeColRef('ORDERS', 'STATUS'));
      const semi = est.estimateSemiJoin(1000, 500, cond);
      const anti = est.estimateAntiJoin(1000, 500, cond);
      expect(anti).toBe(Math.max(1, 1000 - semi));
    });
  });

  describe('estimateJoin with MCV / histogram (skew-aware)', () => {
    function mcvCol(ndv, mcv, extra = {}) {
      const built = mcv ? createMcv(mcv.values, mcv.frequencies) : null;
      return { ndv, min: 0, max: ndv, nullFraction: 0, mcv: built, ...extra };
    }
    function joinStats(colA, colB) {
      const stats = new Map();
      const a = new Map(); a.set('FK', colA);
      const b = new Map(); b.set('PK', colB);
      stats.set('A', { rowCount: 10000, columnStats: a });
      stats.set('B', { rowCount: 10000, columnStats: b });
      return stats;
    }
    const joinCond = makeBinary(makeColRef('A', 'FK'), '=', makeColRef('B', 'PK'));

    it('a shared hot MCV value yields a far larger estimate than the NDV-only formula', () => {
      const est = new DefaultCardinalityEstimator(joinStats(
        mcvCol(1000, { values: ['0'], frequencies: [0.5] }),
        mcvCol(1000, { values: ['0'], frequencies: [0.5] }),
      ));
      const ndvOnly = Math.round((10000 * 10000) / 1000);
      expect(est.estimateJoin(10000, 10000, joinCond)).toBeGreaterThan(ndvOnly * 5);
    });

    it('a uniform MCV distribution stays close to the NDV-only estimate', () => {
      const flat = { values: [], frequencies: [] };
      for (let i = 0; i < 10; i++) { flat.values.push(String(i)); flat.frequencies.push(1 / 1000); }
      const est = new DefaultCardinalityEstimator(joinStats(mcvCol(1000, flat), mcvCol(1000, { ...flat })));
      const ndvOnly = Math.round((10000 * 10000) / 1000);
      const r = est.estimateJoin(10000, 10000, joinCond);
      expect(r).toBeGreaterThan(ndvOnly * 0.7);
      expect(r).toBeLessThan(ndvOnly * 1.4);
    });

    it('falls back to NDV-only when one side has no MCV or histogram', () => {
      const est = new DefaultCardinalityEstimator(joinStats(
        mcvCol(1000, { values: ['0'], frequencies: [0.5] }),
        mcvCol(500, null),
      ));
      const ndvOnly = Math.round((10000 * 10000) / Math.max(1000, 500));
      expect(est.estimateJoin(10000, 10000, joinCond)).toBe(ndvOnly);
    });

    it('clamps selectivity so the estimate never exceeds the cartesian product', () => {
      const est = new DefaultCardinalityEstimator(joinStats(
        mcvCol(10, { values: ['0'], frequencies: [0.9] }),
        mcvCol(10, { values: ['0'], frequencies: [0.9] }),
      ));
      expect(est.estimateJoin(10000, 10000, joinCond)).toBeLessThanOrEqual(10000 * 10000);
    });

    it('does not throw when ndv is smaller than the MCV list', () => {
      const est = new DefaultCardinalityEstimator(joinStats(
        mcvCol(2, { values: ['0', '1', '2'], frequencies: [0.4, 0.3, 0.2] }),
        mcvCol(2, { values: ['0', '1', '2'], frequencies: [0.4, 0.3, 0.2] }),
      ));
      const r = est.estimateJoin(100, 100, joinCond);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
    });

    it('a more concentrated histogram (lower distinct-per-bucket) estimates a larger join', () => {
      const boundaries = [10, 20, 30, 40];
      const counts = [25, 25, 25, 25];
      const concentrated = new EquiDepthHistogram(boundaries, { lowerBound: 0, bucketCounts: counts, bucketDistincts: [1, 1, 25, 25] });
      const spread = new EquiDepthHistogram(boundaries, { lowerBound: 0, bucketCounts: counts, bucketDistincts: [25, 25, 25, 25] });
      const col = (h) => ({ ndv: 76, min: 0, max: 40, nullFraction: 0, mcv: null, histogram: h });

      const concEst = new DefaultCardinalityEstimator(joinStats(col(concentrated), col(concentrated)));
      const spreadEst = new DefaultCardinalityEstimator(joinStats(col(spread), col(spread)));
      expect(concEst.estimateJoin(10000, 10000, joinCond))
        .toBeGreaterThan(spreadEst.estimateJoin(10000, 10000, joinCond));
    });

    it('semi join credits a hot value confirmed present on the build side', () => {
      const withOverlap = new DefaultCardinalityEstimator(joinStats(
        mcvCol(1000, { values: ['0'], frequencies: [0.6] }),
        mcvCol(50, { values: ['0'], frequencies: [0.5] }),
      ));
      const noStats = new DefaultCardinalityEstimator(joinStats(
        { ndv: 1000, nullFraction: 0, mcv: null },
        { ndv: 50, nullFraction: 0, mcv: null },
      ));
      expect(withOverlap.estimateSemiJoin(10000, 10000, joinCond))
        .toBeGreaterThan(noStats.estimateSemiJoin(10000, 10000, joinCond));
    });

    it('anti join remains the complement of the MCV-aware semi join', () => {
      const est = new DefaultCardinalityEstimator(joinStats(
        mcvCol(1000, { values: ['0'], frequencies: [0.6] }),
        mcvCol(50, { values: ['0'], frequencies: [0.5] }),
      ));
      const semi = est.estimateSemiJoin(10000, 10000, joinCond);
      expect(est.estimateAntiJoin(10000, 10000, joinCond)).toBe(Math.max(1, 10000 - semi));
    });

    const disjointMcv = (prefix) => ({ values: [`${prefix}1`, `${prefix}2`], frequencies: [0.3, 0.3] });

    it('keeps the non-MCV tail on a nullable column instead of collapsing it to the floor', () => {
      const est = new DefaultCardinalityEstimator(joinStats(
        mcvCol(100, disjointMcv('a'), { nullFraction: 0.5 }),
        mcvCol(100, disjointMcv('b'), { nullFraction: 0.5 }),
      ));
      const tailShare = (1 - 0.5) * (1 - 0.6);
      const expected = Math.round(10000 * 10000 * ((tailShare * tailShare) / 98));
      expect(est.estimateJoin(10000, 10000, joinCond)).toBe(expected);
    });

    it('scales the join tail linearly with the non-null fraction', () => {
      const selectivityFor = (nullFraction) => new DefaultCardinalityEstimator(joinStats(
        mcvCol(100, disjointMcv('a'), { nullFraction }),
        mcvCol(100, disjointMcv('b')),
      )).estimateEquiJoinSelectivity(makeColRef('A', 'FK'), makeColRef('B', 'PK'), 10000, 10000);
      expect(selectivityFor(0) / selectivityFor(0.5)).toBeCloseTo(2, 10);
    });

    it('semi join keeps the non-MCV tail on a nullable probe column', () => {
      const est = new DefaultCardinalityEstimator(joinStats(
        mcvCol(100, disjointMcv('a'), { nullFraction: 0.5 }),
        mcvCol(60, disjointMcv('b')),
      ));
      const expected = Math.round(10000 * ((1 - 0.5) * (1 - 0.6) * (58 / 98)));
      expect(est.estimateSemiJoin(10000, 10000, joinCond)).toBe(expected);
    });

    const hotMcv = () => ({ values: ['h'], frequencies: [0.5] });

    it('scales the whole equi-join selectivity by the product of the non-null fractions', () => {
      const selectivityFor = (nullFractionA, nullFractionB) => new DefaultCardinalityEstimator(joinStats(
        mcvCol(100, hotMcv(), { nullFraction: nullFractionA }),
        mcvCol(100, hotMcv(), { nullFraction: nullFractionB }),
      )).estimateEquiJoinSelectivity(makeColRef('A', 'FK'), makeColRef('B', 'PK'), 10000, 10000);
      expect(selectivityFor(0.5, 0.5)).toBeCloseTo(selectivityFor(0, 0) * 0.25, 12);
      expect(selectivityFor(0.5, 0)).toBeCloseTo(selectivityFor(0, 0) * 0.5, 12);
    });

    it('scales the whole semi-join selectivity by the probe-side non-null fraction', () => {
      const selectivityFor = (nullFraction) => new DefaultCardinalityEstimator(joinStats(
        mcvCol(100, { values: ['h'], frequencies: [0.6] }, { nullFraction }),
        mcvCol(60, { values: ['h'], frequencies: [0.5] }),
      )).estimateSemiJoinSelectivity(makeColRef('A', 'FK'), makeColRef('B', 'PK'));
      expect(selectivityFor(0.5)).toBeCloseTo(selectivityFor(0) * 0.5, 12);
    });

    it('credits a hot value on a half-null column with a quarter of the row pairs', () => {
      const est = new DefaultCardinalityEstimator(joinStats(
        mcvCol(100, hotMcv(), { nullFraction: 0.5 }),
        mcvCol(100, hotMcv(), { nullFraction: 0.5 }),
      ));
      const nonNull = 1 - 0.5;
      const hotPairs = nonNull * nonNull * (0.5 * 0.5);
      const tailPairs = (nonNull * 0.5) * (nonNull * 0.5) / 99;
      expect(est.estimateJoin(10000, 10000, joinCond)).toBe(Math.round(10000 * 10000 * (hotPairs + tailPairs)));
    });
  });

  describe('estimateAggregate', () => {
    it('returns 1 for no group-by', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimateAggregate(10000, 0)).toBe(1);
    });

    it('uses NDV of group-by columns', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const groupBy = [makeColRef('ORDERS', 'STATUS')];
      const result = est.estimateAggregate(10000, 1, groupBy);
      expect(result).toBe(5);
    });

    it('caps at input cardinality', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const groupBy = [makeColRef('ORDERS', 'ID')];
      const result = est.estimateAggregate(100, 1, groupBy);
      expect(result).toBeLessThanOrEqual(100);
    });
  });

  describe('estimateSelectivity', () => {
    it('returns 1.0 for null predicate', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimateSelectivity(null)).toBe(1.0);
    });

    it('AND combines selectivities', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const left = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('A'));
      const right = makeBinary(makeColRef('ORDERS', 'AMOUNT'), '>', makeLiteral(5000));
      const andPred = makeBinary(left, 'AND', right);
      const selAnd = est.estimateSelectivity(andPred);
      const selLeft = est.estimateSelectivity(left);
      const selRight = est.estimateSelectivity(right);
      expect(selAnd).toBeLessThanOrEqual(Math.min(selLeft, selRight));
    });

    it('AND selectivity with high correlation produces higher selectivity than independent', async () => {
      const { TableStatistics, ColumnStatistics } = await import('../../src/catalog/statistics.js');
      const columns = new Map();
      columns.set('PRICE', new ColumnStatistics({ ndv: 1000, min: 0, max: 10000, nullFraction: 0 }));
      columns.set('COST', new ColumnStatistics({ ndv: 800, min: 0, max: 9000, nullFraction: 0 }));
      const correlations = new Map();
      const tblStats = new TableStatistics(10000, columns, correlations);
      tblStats.setCorrelation('PRICE', 'COST', 0.95);
      const stats = new Map();
      stats.set('T', tblStats);

      const est = new DefaultCardinalityEstimator(stats);
      const left = makeBinary(makeColRef('T', 'PRICE'), '>', makeLiteral(5000));
      const right = makeBinary(makeColRef('T', 'COST'), '>', makeLiteral(4000));
      const andPred = makeBinary(left, 'AND', right);

      const selAnd = est.estimateSelectivity(andPred);
      const selLeft = est.estimateSelectivity(left);
      const selRight = est.estimateSelectivity(right);
      const independent = selLeft * selRight;
      expect(selAnd).toBeGreaterThan(independent);
    });

    it('OR increases selectivity', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const left = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('A'));
      const right = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('B'));
      const orPred = makeBinary(left, 'OR', right);
      const selOr = est.estimateSelectivity(orPred);
      const selLeft = est.estimateSelectivity(left);
      expect(selOr).toBeGreaterThan(selLeft);
    });

    it('NOT inverts selectivity', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const inner = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('A'));
      const notPred = { kind: BoundExprKind.UNARY, op: 'NOT', operand: inner };
      const selInner = est.estimateSelectivity(inner);
      const selNot = est.estimateSelectivity(notPred);
      expect(selNot).toBeCloseTo(1.0 - selInner, 3);
    });

    it('<> returns complement of equality', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const eq = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('A'));
      const neq = makeBinary(makeColRef('ORDERS', 'STATUS'), '<>', makeLiteral('A'));
      const selEq = est.estimateSelectivity(eq);
      const selNeq = est.estimateSelectivity(neq);
      expect(selEq + selNeq).toBeCloseTo(1.0, 2);
    });

    it('EXISTS without a subquery plan falls back to the configured selectivity', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const saved = Config.defaultExistsSelectivity;
      Config.defaultExistsSelectivity = 0.25;
      try {
        expect(est.estimateSelectivity({ kind: BoundExprKind.EXISTS })).toBe(0.25);
      } finally {
        Config.defaultExistsSelectivity = saved;
      }
    });
  });

  describe('estimateSelectivity of EXISTS over a bound subquery', () => {
    function boundPredicate(sql) {
      const catalog = new Catalog();
      catalog.registerTable('users', [
        { name: 'ID', dataType: DataType.INT32 },
        { name: 'NAME', dataType: DataType.VARCHAR },
      ]);
      catalog.registerTable('orders', [
        { name: 'ID', dataType: DataType.INT32 },
        { name: 'USER_ID', dataType: DataType.INT32 },
      ]);
      const binder = new Binder(catalog, new FunctionRegistry());
      return binder.bind(parse(sql)).where;
    }

    function ordersStats(rowCount) {
      const columns = new Map();
      columns.set('ID', { ndv: rowCount, nullFraction: 0 });
      columns.set('USER_ID', { ndv: Math.max(1, rowCount / 10), nullFraction: 0 });
      const stats = new Map();
      stats.set('USERS', { rowCount: 1000, columnStats: new Map() });
      stats.set('ORDERS', { rowCount, columnStats: columns });
      return stats;
    }

    const exists = () => boundPredicate('SELECT u.id FROM users u WHERE EXISTS (SELECT o.id FROM orders o)');
    const notExists = () => boundPredicate('SELECT u.id FROM users u WHERE NOT EXISTS (SELECT o.id FROM orders o)');

    it('runs from almost impossible for an empty subquery to almost certain for a large one', () => {
      const onEmpty = new DefaultCardinalityEstimator(ordersStats(0)).estimateSelectivity(exists());
      const onLarge = new DefaultCardinalityEstimator(ordersStats(1000000)).estimateSelectivity(exists());
      expect(onEmpty).toBeLessThan(0.01);
      expect(onLarge).toBeGreaterThan(0.99);
    });

    it('NOT EXISTS over a large subquery is almost impossible', () => {
      const est = new DefaultCardinalityEstimator(ordersStats(1000000));
      expect(est.estimateSelectivity(notExists())).toBeLessThan(0.01);
    });

    it('memoizes the subquery estimate so a repeated predicate is planned once', () => {
      const est = new DefaultCardinalityEstimator(ordersStats(1000000));
      const predicate = exists();
      est.estimateSelectivity(predicate);
      expect(est.subqueryCardinalities.get(predicate.plan)).toBe(1000000);
    });
  });

  describe('estimateRangeSelectivity', () => {
    it('uses min/max to estimate fraction', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = makeBinary(makeColRef('ORDERS', 'AMOUNT'), '<', makeLiteral(5000));
      const sel = est.estimateSelectivity(pred);
      expect(sel).toBeCloseTo(0.5, 1);
    });

    it('returns default when no stats available', () => {
      const est = new DefaultCardinalityEstimator(new Map());
      const pred = makeBinary(makeColRef('ORDERS', 'X'), '>', makeLiteral(10));
      expect(est.estimateSelectivity(pred)).toBe(0.33);
    });
  });

  describe('estimateBetweenSelectivity', () => {
    it('estimates fraction of range covered', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = {
        kind: BoundExprKind.BETWEEN,
        expr: makeColRef('ORDERS', 'AMOUNT'),
        low: makeLiteral(2000),
        high: makeLiteral(8000),
        negated: false,
      };
      const sel = est.estimateSelectivity(pred);
      expect(sel).toBeCloseTo(0.6, 1);
    });

    it('negated BETWEEN inverts the selectivity', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = {
        kind: BoundExprKind.BETWEEN,
        expr: makeColRef('ORDERS', 'AMOUNT'),
        low: makeLiteral(2000),
        high: makeLiteral(8000),
        negated: false,
      };
      const negPred = { ...pred, negated: true };
      const sel = est.estimateSelectivity(pred);
      const negSel = est.estimateSelectivity(negPred);
      expect(sel + negSel).toBeCloseTo(1.0, 1);
    });
  });

  describe('estimateInListSelectivity', () => {
    it('scales with list size relative to NDV', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = {
        kind: BoundExprKind.IN_LIST,
        expr: makeColRef('ORDERS', 'STATUS'),
        list: [makeLiteral('A'), makeLiteral('B')],
        negated: false,
      };
      const sel = est.estimateSelectivity(pred);
      expect(sel).toBeCloseTo(2 / 5, 1);
    });

    it('negated IN_LIST inverts selectivity', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = {
        kind: BoundExprKind.IN_LIST,
        expr: makeColRef('ORDERS', 'STATUS'),
        list: [makeLiteral('A')],
        negated: false,
      };
      const negPred = { ...pred, negated: true };
      const sel = est.estimateSelectivity(pred);
      const negSel = est.estimateSelectivity(negPred);
      expect(negSel).toBeGreaterThan(sel);
    });
  });

  describe('estimateIsNullSelectivity', () => {
    it('uses null fraction from stats', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = {
        kind: BoundExprKind.IS_NULL,
        expr: makeColRef('ORDERS', 'STATUS'),
        negated: false,
      };
      const sel = est.estimateSelectivity(pred);
      expect(sel).toBeCloseTo(0.02, 2);
    });

    it('IS NOT NULL returns complement', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = {
        kind: BoundExprKind.IS_NULL,
        expr: makeColRef('ORDERS', 'STATUS'),
        negated: true,
      };
      const sel = est.estimateSelectivity(pred);
      expect(sel).toBeCloseTo(0.98, 2);
    });

    it('respects a zero null fraction instead of falling back to the default', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = {
        kind: BoundExprKind.IS_NULL,
        expr: makeColRef('ORDERS', 'AMOUNT'),
        negated: false,
      };
      const sel = est.estimateSelectivity(pred);
      expect(sel).toBeLessThan(0.05);
    });

    it('IS NOT NULL on a non-nullable column is near-certain', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const pred = {
        kind: BoundExprKind.IS_NULL,
        expr: makeColRef('ORDERS', 'AMOUNT'),
        negated: true,
      };
      const sel = est.estimateSelectivity(pred);
      expect(sel).toBeCloseTo(1.0, 4);
    });

    it('falls back to a default null fraction when stats are absent', () => {
      const est = new DefaultCardinalityEstimator(new Map());
      const pred = {
        kind: BoundExprKind.IS_NULL,
        expr: makeColRef('ORDERS', 'UNKNOWN'),
        negated: false,
      };
      const sel = est.estimateSelectivity(pred);
      expect(sel).toBeCloseTo(0.05, 4);
    });
  });

  describe('estimateLikeSelectivity', () => {
    it('prefix pattern is more selective than contains', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const prefix = {
        kind: BoundExprKind.LIKE,
        expr: makeColRef('ORDERS', 'STATUS'),
        pattern: makeLiteral('ABCDEF%'),
      };
      const contains = {
        kind: BoundExprKind.LIKE,
        expr: makeColRef('ORDERS', 'STATUS'),
        pattern: makeLiteral('%ABC%'),
      };
      expect(est.estimateSelectivity(prefix)).toBeLessThan(est.estimateSelectivity(contains));
    });

    it('exact match uses NDV', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      const exact = {
        kind: BoundExprKind.LIKE,
        expr: makeColRef('ORDERS', 'STATUS'),
        pattern: makeLiteral('ACTIVE'),
      };
      expect(est.estimateSelectivity(exact)).toBeCloseTo(1 / 5, 1);
    });

    it('prefix pattern uses avgLength when available', () => {
      const stats = new Map();
      const columns = new Map();
      columns.set('NAME', { ndv: 1000, min: null, max: null, nullFraction: 0, avgLength: 10 });
      stats.set('T', { rowCount: 5000, columnStats: columns });
      const est = new DefaultCardinalityEstimator(stats);
      const shortPrefix = {
        kind: BoundExprKind.LIKE,
        expr: makeColRef('T', 'NAME'),
        pattern: makeLiteral('AB%'),
      };
      const longPrefix = {
        kind: BoundExprKind.LIKE,
        expr: makeColRef('T', 'NAME'),
        pattern: makeLiteral('ABCDEFGH%'),
      };
      expect(est.estimateSelectivity(longPrefix)).toBeLessThan(est.estimateSelectivity(shortPrefix));
    });

    it('contains pattern uses avgLength for coverage ratio', () => {
      const stats = new Map();
      const columns = new Map();
      columns.set('DESC', { ndv: 500, min: null, max: null, nullFraction: 0, avgLength: 20 });
      stats.set('T', { rowCount: 5000, columnStats: columns });
      const est = new DefaultCardinalityEstimator(stats);
      const shortContains = {
        kind: BoundExprKind.LIKE,
        expr: makeColRef('T', 'DESC'),
        pattern: makeLiteral('%AB%'),
      };
      const longContains = {
        kind: BoundExprKind.LIKE,
        expr: makeColRef('T', 'DESC'),
        pattern: makeLiteral('%ABCDEFGHIJKLMNOP%'),
      };
      expect(est.estimateSelectivity(longContains)).toBeLessThan(est.estimateSelectivity(shortContains));
    });
  });

  describe('estimateEqualitySelectivity with MCV', () => {
    function statusStats(column) {
      const stats = new Map();
      const columns = new Map();
      columns.set('STATUS', column);
      stats.set('ORDERS', { rowCount: 10000, columnStats: columns });
      return stats;
    }

    it('returns MCV frequency for known value', () => {
      const est = new DefaultCardinalityEstimator(statusStats({
        ndv: 5,
        nullFraction: 0,
        mcv: createMcv(['active', 'pending'], [0.6, 0.3]),
      }));
      const pred = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('active'));
      expect(est.estimateSelectivity(pred)).toBeCloseTo(0.6, 2);
    });

    it('spreads only the non-MCV mass over the non-MCV distinct values', () => {
      const est = new DefaultCardinalityEstimator(statusStats({
        ndv: 100,
        nullFraction: 0,
        mcv: createMcv(['active', 'pending', 'shipped'], [0.3, 0.3, 0.3]),
      }));
      const pred = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('cancelled'));
      expect(est.estimateSelectivity(pred)).toBeCloseTo((1 - 0.9) / 97, 6);
    });

    it('scales the non-MCV density by the non-null fraction', () => {
      const est = new DefaultCardinalityEstimator(statusStats({
        ndv: 100,
        nullFraction: 0.2,
        mcv: createMcv(['active', 'pending', 'shipped'], [0.3, 0.3, 0.3]),
      }));
      const pred = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('cancelled'));
      expect(est.estimateSelectivity(pred)).toBeCloseTo(0.8 * (1 - 0.9) / 97, 6);
    });
  });

  describe('extractEquiPredicates', () => {
    it('extracts equality predicates between columns', () => {
      const est = new DefaultCardinalityEstimator(new Map());
      const eq = makeBinary(makeColRef('A', 'id'), '=', makeColRef('B', 'a_id'));
      const result = est.extractEquiPredicates(eq);
      expect(result).toHaveLength(1);
      expect(result[0].left.tableAlias).toBe('A');
      expect(result[0].right.tableAlias).toBe('B');
    });

    it('extracts from AND chain', () => {
      const est = new DefaultCardinalityEstimator(new Map());
      const eq1 = makeBinary(makeColRef('A', 'id'), '=', makeColRef('B', 'a_id'));
      const eq2 = makeBinary(makeColRef('A', 'x'), '=', makeColRef('B', 'y'));
      const combined = makeBinary(eq1, 'AND', eq2);
      expect(est.extractEquiPredicates(combined)).toHaveLength(2);
    });

    it('ignores column = literal', () => {
      const est = new DefaultCardinalityEstimator(new Map());
      const pred = makeBinary(makeColRef('A', 'id'), '=', makeLiteral(5));
      expect(est.extractEquiPredicates(pred)).toHaveLength(0);
    });
  });
});
