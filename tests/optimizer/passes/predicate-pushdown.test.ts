import { describe, it, expect } from 'vitest';
import { PredicatePushdown, splitConjuncts } from '../../../src/optimizer/passes/predicate-pushdown.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
  LogicalJoin,
  LogicalAggregate,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new PredicatePushdown();

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function lit(v) {
  return { kind: BoundExprKind.LITERAL, value: v };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function scan(name) {
  return LogicalScan(name, ['id', 'val'], name);
}

function collectFilters(node) {
  const filters = [];
  function walk(n) {
    if (!n) return;
    if (n.type === PlanNodeType.FILTER) filters.push(n);
    for (const c of n.children || []) walk(c);
  }
  walk(node);
  return filters;
}

describe('PredicatePushdown', () => {
  describe('push into INNER JOIN', () => {
    it('pushes left-only predicate to left child', () => {
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('a', 'val'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      const filters = collectFilters(result);
      const leftFilter = filters.find(f =>
        f.children[0].type === PlanNodeType.SCAN && f.children[0].table === 'a'
      );
      expect(leftFilter).toBeDefined();
    });

    it('pushes right-only predicate to right child', () => {
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('b', 'val'), '<', lit(100)),
        join
      );

      const result = pass.apply(plan);

      const filters = collectFilters(result);
      const rightFilter = filters.find(f =>
        f.children[0].type === PlanNodeType.SCAN && f.children[0].table === 'b'
      );
      expect(rightFilter).toBeDefined();
    });

    it('adds cross-table predicate to join condition', () => {
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const crossPred = bin(colRef('a', 'val'), '>', colRef('b', 'val'));
      const plan = LogicalFilter(crossPred, join);

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds.length).toBe(2);
    });

    it('splits mixed predicates correctly', () => {
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const leftPred = bin(colRef('a', 'val'), '>', lit(0));
      const rightPred = bin(colRef('b', 'val'), '<', lit(100));
      const plan = LogicalFilter(bin(leftPred, 'AND', rightPred), join);

      const result = pass.apply(plan);

      const filters = collectFilters(result);
      expect(filters.length).toBe(2);
    });
  });

  describe('push into LEFT JOIN', () => {
    it('pushes left-only predicate to left child of LEFT JOIN', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('a', 'val'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      const filters = collectFilters(result);
      const leftFilter = filters.find(f =>
        f.children[0].type === PlanNodeType.SCAN && f.children[0].table === 'a'
      );
      expect(leftFilter).toBeDefined();
    });

    it('does not push right-only non-null-rejecting predicate into LEFT JOIN right side', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const isNullPred = { kind: BoundExprKind.IS_NULL, expr: colRef('b', 'val'), negated: false };
      const plan = LogicalFilter(isNullPred, join);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
      expect(result.children[0].joinType).toBe(JoinType.LEFT);
    });

    it('converts LEFT to INNER and pushes null-rejecting right predicate', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('b', 'val'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      function findJoins(n) {
        const joins = [];
        if (!n) return joins;
        if (n.type === PlanNodeType.JOIN) joins.push(n);
        for (const c of n.children || []) joins.push(...findJoins(c));
        return joins;
      }
      const joins = findJoins(result);
      expect(joins.some(j => j.joinType === JoinType.INNER)).toBe(true);
    });
  });

  describe('push through PROJECT', () => {
    it('pushes predicate through project when columns are available below', () => {
      const project = LogicalProject(
        [colRef('t', 'id'), colRef('t', 'val')],
        scan('t')
      );
      const plan = LogicalFilter(
        bin(colRef('t', 'id'), '>', lit(0)),
        project
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      const filters = collectFilters(result);
      expect(filters.length).toBe(1);
      expect(filters[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('merge consecutive filters', () => {
    it('combines stacked filters and pushes them together', () => {
      const inner = LogicalFilter(
        bin(colRef('t', 'id'), '>', lit(0)),
        scan('t')
      );
      const plan = LogicalFilter(
        bin(colRef('t', 'val'), '<', lit(100)),
        inner
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(2);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('CROSS JOIN upgrade', () => {
    it('converts CROSS JOIN to INNER when predicate is pushed into condition', () => {
      const join = LogicalJoin(JoinType.CROSS, null, scan('a'), scan('b'));
      const plan = LogicalFilter(
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        join
      );

      const result = pass.apply(plan);

      function findJoins(n) {
        const joins = [];
        if (!n) return joins;
        if (n.type === PlanNodeType.JOIN) joins.push(n);
        for (const c of n.children || []) joins.push(...findJoins(c));
        return joins;
      }
      const joins = findJoins(result);
      expect(joins.some(j => j.joinType === JoinType.INNER)).toBe(true);
    });
  });

  describe('LEFT JOIN condition pushdown', () => {
    it('pushes right-only predicates from LEFT JOIN condition to right child', () => {
      const rightPred = bin(colRef('b', 'val'), '>', lit(0));
      const joinPred = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const combined = bin(joinPred, 'AND', rightPred);

      const plan = LogicalJoin(
        JoinType.LEFT,
        combined,
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      const filters = collectFilters(result);
      const rightFilter = filters.find(f =>
        f.children[0].type === PlanNodeType.SCAN && f.children[0].table === 'b'
      );
      expect(rightFilter).toBeDefined();
    });
  });

  describe('no pushdown possible', () => {
    it('leaves filter in place when it cannot be pushed', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'id'), '>', lit(0)),
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('pushdown through AGGREGATE', () => {
    it('pushes predicate on group-by column below aggregate', () => {
      const agg = LogicalAggregate(
        [colRef('t', 'status')],
        [{ func: 'COUNT', args: [], outputName: 'cnt' }],
        scan('t')
      );
      const plan = LogicalFilter(
        bin(colRef('t', 'status'), '=', lit('ACTIVE')),
        agg
      );

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('does not push a predicate that contains an aggregate, even on a group-by column arg', () => {
      const agg = LogicalAggregate(
        [colRef('t', 'g')],
        [{ kind: BoundExprKind.AGGREGATE, name: 'SUM', args: [colRef('t', 'g')], distinct: false, resultType: 'INT32' }],
        scan('t')
      );
      const plan = LogicalFilter(
        bin({ kind: BoundExprKind.AGGREGATE, name: 'SUM', args: [colRef('t', 'g')], distinct: false, resultType: 'INT32' }, '<', lit(3)),
        agg
      );

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('keeps predicate on aggregate output above aggregate', () => {
      const agg = LogicalAggregate(
        [colRef('t', 'status')],
        [{ func: 'COUNT', args: [], outputName: 'cnt' }],
        scan('t')
      );
      const plan = LogicalFilter(
        bin(colRef('', 'cnt'), '>', lit(10)),
        agg
      );

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
    });

    it('splits mixed predicates: pushes group-by, keeps aggregate output', () => {
      const agg = LogicalAggregate(
        [colRef('t', 'status')],
        [{ func: 'SUM', args: [colRef('t', 'val')], outputName: 'total' }],
        scan('t')
      );
      const plan = LogicalFilter(
        bin(
          bin(colRef('t', 'status'), '=', lit('X')),
          'AND',
          bin(colRef('', 'total'), '>', lit(100))
        ),
        agg
      );

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.FILTER);
    });
  });
});
