import { describe, it, expect } from 'vitest';
import { PredicateDedup } from '../../../src/optimizer/passes/predicate-dedup.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { splitConjuncts } from '../../../src/binder/conjuncts.js';

const pass = new PredicateDedup();

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function lit(v, dt) {
  return { kind: BoundExprKind.LITERAL, value: v, dataType: dt };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function scan(name) {
  return LogicalScan(name, ['id', 'val'], name);
}

describe('PredicateDedup', () => {
  describe('filter deduplication', () => {
    it('removes duplicate predicates from AND chain', () => {
      const pred = bin(colRef('t', 'id'), '>', lit(0));
      const plan = LogicalFilter(bin(pred, 'AND', pred), scan('t'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(1);
    });

    it('keeps distinct predicates', () => {
      const p1 = bin(colRef('t', 'id'), '>', lit(0));
      const p2 = bin(colRef('t', 'val'), '<', lit(100));
      const plan = LogicalFilter(bin(p1, 'AND', p2), scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(2);
    });

    it('deduplicates three copies down to one', () => {
      const pred = bin(colRef('t', 'id'), '=', lit(5));
      const combined = bin(bin(pred, 'AND', pred), 'AND', pred);
      const plan = LogicalFilter(combined, scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(1);
    });

    it('removes filter entirely when all predicates are duplicates of nothing', () => {
      const plan = LogicalFilter(null, scan('t'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('commutative deduplication', () => {
    it('detects a = b and b = a as the same predicate', () => {
      const p1 = bin(colRef('t', 'id'), '=', colRef('t', 'val'));
      const p2 = bin(colRef('t', 'val'), '=', colRef('t', 'id'));
      const plan = LogicalFilter(bin(p1, 'AND', p2), scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(1);
    });

    it('does not treat a > b and b > a as duplicates', () => {
      const p1 = bin(colRef('t', 'id'), '>', colRef('t', 'val'));
      const p2 = bin(colRef('t', 'val'), '>', colRef('t', 'id'));
      const plan = LogicalFilter(bin(p1, 'AND', p2), scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(2);
    });
  });

  describe('join condition deduplication', () => {
    it('removes duplicate predicates from join condition', () => {
      const pred = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const plan = LogicalJoin(
        JoinType.INNER,
        bin(pred, 'AND', pred),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(1);
    });

    it('keeps distinct join predicates', () => {
      const p1 = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const p2 = bin(colRef('a', 'val'), '=', colRef('b', 'val'));
      const plan = LogicalJoin(
        JoinType.INNER,
        bin(p1, 'AND', p2),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(2);
    });

    it('nulls out condition when all join predicates are duplicates removed', () => {
      const plan = LogicalJoin(JoinType.INNER, null, scan('a'), scan('b'));

      const result = pass.apply(plan);

      expect(result.condition).toBeNull();
    });
  });

  describe('case insensitive column matching', () => {
    it('treats T.ID and t.id as the same column', () => {
      const p1 = bin(colRef('T', 'ID'), '>', lit(0));
      const p2 = bin(colRef('t', 'id'), '>', lit(0));
      const plan = LogicalFilter(bin(p1, 'AND', p2), scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(1);
    });
  });

  describe('recursive deduplication', () => {
    it('deduplicates at multiple levels in the tree', () => {
      const pred = bin(colRef('t', 'id'), '=', lit(1));
      const innerFilter = LogicalFilter(bin(pred, 'AND', pred), scan('t'));
      const plan = LogicalFilter(
        bin(colRef('t', 'val'), '>', lit(0)),
        innerFilter
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      const inner = result.children[0];
      expect(inner.type).toBe(PlanNodeType.FILTER);
      const innerPreds = splitConjuncts(inner.condition);
      expect(innerPreds).toHaveLength(1);
    });
  });
});
