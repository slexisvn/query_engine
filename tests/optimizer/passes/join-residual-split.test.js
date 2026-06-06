import { describe, it, expect } from 'vitest';
import { JoinResidualSplit } from '../../../src/optimizer/passes/join-residual-split.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalJoin,
  LogicalFilter,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new JoinResidualSplit();

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

describe('JoinResidualSplit', () => {
  describe('cross-side OR predicate', () => {
    it('splits OR referencing both sides into residual filter', () => {
      const eqPred = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const orPred = bin(colRef('a', 'val'), 'OR', colRef('b', 'val'));
      const combined = bin(eqPred, 'AND', orPred);

      const plan = LogicalJoin(
        JoinType.INNER,
        combined,
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
      expect(result.children[0].condition.op).toBe('=');
    });

    it('places OR predicate in the filter condition', () => {
      const eqPred = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const orPred = bin(colRef('a', 'val'), 'OR', colRef('b', 'val'));
      const combined = bin(eqPred, 'AND', orPred);

      const plan = LogicalJoin(
        JoinType.INNER,
        combined,
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.condition.op).toBe('OR');
    });
  });

  describe('no residual predicates', () => {
    it('returns join unchanged when all predicates are equi-joins', () => {
      const eqPred = bin(colRef('a', 'id'), '=', colRef('b', 'id'));

      const plan = LogicalJoin(
        JoinType.INNER,
        eqPred,
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.condition.op).toBe('=');
    });
  });

  describe('all residual predicates', () => {
    it('returns join unchanged when all predicates are cross-side OR', () => {
      const orPred = bin(colRef('a', 'val'), 'OR', colRef('b', 'val'));

      const plan = LogicalJoin(
        JoinType.INNER,
        orPred,
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('LEFT JOIN is skipped', () => {
    it('does not split predicates on LEFT JOIN', () => {
      const eqPred = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const orPred = bin(colRef('a', 'val'), 'OR', colRef('b', 'val'));
      const combined = bin(eqPred, 'AND', orPred);

      const plan = LogicalJoin(
        JoinType.LEFT,
        combined,
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('no condition', () => {
    it('returns join unchanged when no condition', () => {
      const plan = LogicalJoin(JoinType.INNER, null, scan('a'), scan('b'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('multiple residual OR predicates', () => {
    it('combines multiple OR residuals into one filter', () => {
      const eqPred = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const or1 = bin(colRef('a', 'val'), 'OR', colRef('b', 'val'));
      const or2 = bin(colRef('a', 'id'), 'OR', colRef('b', 'id'));
      const combined = bin(bin(eqPred, 'AND', or1), 'AND', or2);

      const plan = LogicalJoin(
        JoinType.INNER,
        combined,
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('single-side OR is not residual', () => {
    it('keeps OR that references only one side in the join condition', () => {
      const eqPred = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const singleSideOr = bin(
        bin(colRef('a', 'val'), '>', lit(10)),
        'OR',
        bin(colRef('a', 'val'), '<', lit(5))
      );
      const combined = bin(eqPred, 'AND', singleSideOr);

      const plan = LogicalJoin(
        JoinType.INNER,
        combined,
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('recursive rewriting', () => {
    it('splits residuals in nested joins', () => {
      const innerEq = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const innerOr = bin(colRef('a', 'val'), 'OR', colRef('b', 'val'));
      const innerCombined = bin(innerEq, 'AND', innerOr);

      const innerJoin = LogicalJoin(JoinType.INNER, innerCombined, scan('a'), scan('b'));

      const outerEq = bin(colRef('a', 'id'), '=', colRef('c', 'id'));
      const outerJoin = LogicalJoin(JoinType.INNER, outerEq, innerJoin, scan('c'));

      const result = pass.apply(outerJoin);

      function hasFilter(n) {
        if (!n) return false;
        if (n.type === PlanNodeType.FILTER) return true;
        return (n.children || []).some(hasFilter);
      }
      expect(hasFilter(result)).toBe(true);
    });
  });
});
