import { describe, it, expect } from 'vitest';
import { DefaultCardinalityEstimator } from '../../../src/optimizer/dphyp/cardinality.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { PlanNodeType, JoinType } from '../../../src/planner/logical-plan.js';

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
      const { TableStatistics, ColumnStatistics } = await import('../../../src/catalog/statistics.js');
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

    it('EXISTS returns 0.5', () => {
      const est = new DefaultCardinalityEstimator(makeStats());
      expect(est.estimateSelectivity({ kind: BoundExprKind.EXISTS })).toBe(0.5);
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
    it('returns MCV frequency for known value', () => {
      const stats = new Map();
      const columns = new Map();
      columns.set('STATUS', {
        ndv: 5,
        nullFraction: 0,
        mcv: { values: ['active', 'pending'], frequencies: [0.6, 0.3] },
      });
      stats.set('ORDERS', { rowCount: 10000, columnStats: columns });
      const est = new DefaultCardinalityEstimator(stats);
      const pred = makeBinary(makeColRef('ORDERS', 'STATUS'), '=', makeLiteral('active'));
      expect(est.estimateSelectivity(pred)).toBeCloseTo(0.6, 2);
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
