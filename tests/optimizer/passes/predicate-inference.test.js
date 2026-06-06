import { describe, it, expect } from 'vitest';
import { PredicateInference } from '../../../src/optimizer/passes/predicate-inference.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { splitConjuncts } from '../../../src/optimizer/passes/predicate-pushdown.js';

const pass = new PredicateInference();

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
  return LogicalScan(name, ['id', 'val', 'status'], name);
}

function countPredicates(node) {
  if (node.type === PlanNodeType.FILTER) {
    return splitConjuncts(node.condition).length;
  }
  return 0;
}

describe('PredicateInference', () => {
  describe('transitive equality: A.x = B.x AND B.x = 5 => A.x = 5', () => {
    it('infers A.x = 5 from A.x = B.x AND B.x = 5', () => {
      const eq = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const lit5 = bin(colRef('b', 'id'), '=', lit(5));
      const plan = LogicalFilter(bin(eq, 'AND', lit5), scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds.length).toBeGreaterThan(2);

      const hasInferred = preds.some(p =>
        p.kind === BoundExprKind.BINARY
        && p.op === '='
        && p.left?.tableAlias?.toUpperCase() === 'A'
        && p.right?.value === 5
      );
      expect(hasInferred).toBe(true);
    });

    it('does not infer when no transitivity exists', () => {
      const p1 = bin(colRef('a', 'id'), '>', lit(0));
      const p2 = bin(colRef('b', 'val'), '<', lit(100));
      const plan = LogicalFilter(bin(p1, 'AND', p2), scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(2);
    });
  });

  describe('transitive range: A.x = B.x AND A.x > 10 => B.x > 10', () => {
    it('infers B.x > 10 from equality and range on A.x', () => {
      const eq = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const range = bin(colRef('a', 'id'), '>', lit(10));
      const plan = LogicalFilter(bin(eq, 'AND', range), scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds.length).toBeGreaterThan(2);

      const hasInferred = preds.some(p =>
        p.kind === BoundExprKind.BINARY
        && p.op === '>'
        && p.left?.tableAlias?.toUpperCase() === 'B'
        && p.right?.value === 10
      );
      expect(hasInferred).toBe(true);
    });
  });

  describe('OR → IN_LIST inference', () => {
    it('infers IN list from x=1 OR x=2', () => {
      const branch1 = bin(colRef('t', 'status'), '=', lit(1));
      const branch2 = bin(colRef('t', 'status'), '=', lit(2));
      const orPred = bin(branch1, 'OR', branch2);
      const plan = LogicalFilter(orPred, scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      const hasInList = preds.some(p => p.kind === BoundExprKind.IN_LIST);
      expect(hasInList).toBe(true);
    });

    it('does not infer IN list when OR branches reference different columns', () => {
      const branch1 = bin(colRef('t', 'id'), '=', lit(1));
      const branch2 = bin(colRef('t', 'val'), '=', lit(2));
      const orPred = bin(branch1, 'OR', branch2);
      const plan = LogicalFilter(orPred, scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      const hasInList = preds.some(p => p.kind === BoundExprKind.IN_LIST);
      expect(hasInList).toBe(false);
    });
  });

  describe('join predicate inference', () => {
    it('pushes inferred predicate to join child as filter', () => {
      const joinCond = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const leftFilter = LogicalFilter(
        bin(colRef('a', 'id'), '=', lit(42)),
        scan('a')
      );
      const plan = LogicalJoin(
        JoinType.INNER,
        joinCond,
        leftFilter,
        scan('b')
      );

      const result = pass.apply(plan);

      function findFiltersOn(node, table) {
        const filters = [];
        function walk(n) {
          if (!n) return;
          if (n.type === PlanNodeType.FILTER) {
            const preds = splitConjuncts(n.condition);
            for (const p of preds) {
              if (p.left?.tableAlias?.toUpperCase() === table.toUpperCase()
                  || p.right?.tableAlias?.toUpperCase() === table.toUpperCase()) {
                filters.push(p);
              }
            }
          }
          for (const c of n.children || []) walk(c);
        }
        walk(node);
        return filters;
      }

      const bFilters = findFiltersOn(result, 'B');
      expect(bFilters.length).toBeGreaterThan(0);
    });

    it('does not push inferred predicates for non-INNER joins', () => {
      const joinCond = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const leftFilter = LogicalFilter(
        bin(colRef('a', 'id'), '=', lit(42)),
        scan('a')
      );
      const plan = LogicalJoin(
        JoinType.LEFT,
        joinCond,
        leftFilter,
        scan('b')
      );

      const result = pass.apply(plan);

      const rightChild = result.children[1];
      expect(rightChild.type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('no inference possible', () => {
    it('returns plan unchanged when no predicates can be inferred', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'id'), '>', lit(0)),
        scan('t')
      );

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);
      expect(preds).toHaveLength(1);
    });
  });

  describe('chain transitivity: A=B, B=C, A=5 => B=5, C=5', () => {
    it('infers through a chain of equalities', () => {
      const ab = bin(colRef('a', 'id'), '=', colRef('b', 'id'));
      const bc = bin(colRef('b', 'id'), '=', colRef('c', 'id'));
      const a5 = bin(colRef('a', 'id'), '=', lit(5));
      const combined = bin(bin(ab, 'AND', bc), 'AND', a5);
      const plan = LogicalFilter(combined, scan('t'));

      const result = pass.apply(plan);

      const preds = splitConjuncts(result.condition);

      const bEq5 = preds.some(p =>
        p.op === '=' && p.left?.tableAlias?.toUpperCase() === 'B' && p.right?.value === 5
      );
      const cEq5 = preds.some(p =>
        p.op === '=' && p.left?.tableAlias?.toUpperCase() === 'C' && p.right?.value === 5
      );
      expect(bEq5).toBe(true);
      expect(cEq5).toBe(true);
    });
  });
});
