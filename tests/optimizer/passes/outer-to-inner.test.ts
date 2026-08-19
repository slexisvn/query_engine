import { describe, it, expect } from 'vitest';
import { OuterToInnerJoin } from '../../../src/optimizer/passes/outer-to-inner.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new OuterToInnerJoin();

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

describe('OuterToInnerJoin', () => {
  describe('LEFT JOIN → INNER', () => {
    it('converts LEFT to INNER when filter rejects nulls from right side', () => {
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

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].joinType).toBe(JoinType.INNER);
    });

    it('keeps LEFT when filter only references left side', () => {
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

      expect(result.children[0].joinType).toBe(JoinType.LEFT);
    });

    it('keeps LEFT when filter is IS NULL on right side', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        { kind: BoundExprKind.IS_NULL, expr: colRef('b', 'val') },
        join
      );

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.LEFT);
    });
  });

  describe('RIGHT JOIN → INNER', () => {
    it('converts RIGHT to INNER when filter rejects nulls from left side', () => {
      const join = LogicalJoin(
        JoinType.RIGHT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('a', 'val'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.INNER);
    });

    it('keeps RIGHT when filter only references right side', () => {
      const join = LogicalJoin(
        JoinType.RIGHT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('b', 'val'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.RIGHT);
    });
  });

  describe('FULL JOIN conversions', () => {
    it('converts FULL to INNER when both sides are null-rejected', () => {
      const join = LogicalJoin(
        JoinType.FULL,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const pred = bin(
        bin(colRef('a', 'val'), '>', lit(0)),
        'AND',
        bin(colRef('b', 'val'), '>', lit(0))
      );
      const plan = LogicalFilter(pred, join);

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.INNER);
    });

    it('converts FULL to LEFT when only left is null-rejected', () => {
      const join = LogicalJoin(
        JoinType.FULL,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('a', 'val'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.LEFT);
    });

    it('converts FULL to RIGHT when only right is null-rejected', () => {
      const join = LogicalJoin(
        JoinType.FULL,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('b', 'val'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.RIGHT);
    });

    it('keeps FULL when filter does not reject nulls from either side', () => {
      const join = LogicalJoin(
        JoinType.FULL,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(lit(true), join);

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.FULL);
    });
  });

  describe('null-rejecting detection', () => {
    it('comparison with literal is null-rejecting', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('b', 'val'), '=', lit(42)),
        join
      );

      const result = pass.apply(plan);
      expect(result.children[0].joinType).toBe(JoinType.INNER);
    });

    it('AND with one null-rejecting branch is null-rejecting', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const pred = bin(
        bin(colRef('b', 'val'), '>', lit(0)),
        'AND',
        lit(true)
      );
      const plan = LogicalFilter(pred, join);

      const result = pass.apply(plan);
      expect(result.children[0].joinType).toBe(JoinType.INNER);
    });

    it('NOT on right-side column is null-rejecting', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        { kind: BoundExprKind.UNARY, op: 'NOT', operand: colRef('b', 'val') },
        join
      );

      const result = pass.apply(plan);
      expect(result.children[0].joinType).toBe(JoinType.INNER);
    });
  });

  describe('INNER JOIN is not modified', () => {
    it('does not touch INNER JOIN', () => {
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('b', 'val'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.INNER);
    });
  });

  describe('no filter above join', () => {
    it('does not convert without a filter', () => {
      const plan = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.joinType).toBe(JoinType.LEFT);
    });
  });

  describe('recursive rewriting', () => {
    it('converts nested outer joins', () => {
      const innerJoin = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const innerFiltered = LogicalFilter(
        bin(colRef('b', 'val'), '>', lit(0)),
        innerJoin
      );
      const outerJoin = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('c', 'id')),
        innerFiltered,
        scan('c')
      );
      const plan = LogicalFilter(
        bin(colRef('c', 'val'), '>', lit(0)),
        outerJoin
      );

      const result = pass.apply(plan);

      expect(result.children[0].joinType).toBe(JoinType.INNER);

      function findJoins(n) {
        const joins = [];
        if (!n) return joins;
        if (n.type === PlanNodeType.JOIN) joins.push(n);
        for (const c of n.children || []) joins.push(...findJoins(c));
        return joins;
      }
      const allJoins = findJoins(result);
      expect(allJoins.every(j => j.joinType === JoinType.INNER)).toBe(true);
    });
  });
});
