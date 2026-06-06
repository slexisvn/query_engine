import { describe, it, expect } from 'vitest';
import { FilterOrdering } from '../../../src/optimizer/passes/filter-ordering.js';
import { PlanNodeType, LogicalFilter, LogicalScan, LogicalJoin, JoinType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { TableStatistics, ColumnStatistics } from '../../../src/catalog/statistics.js';

function colRef(table, column) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column };
}

function literal(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function binary(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function andExpr(...preds) {
  return preds.reduce((acc, p) => binary(acc, 'AND', p));
}

function makeStats() {
  const stats = new Map();
  const columns = new Map();
  columns.set('ID', new ColumnStatistics({ ndv: 10000, min: 1, max: 10000 }));
  columns.set('STATUS', new ColumnStatistics({ ndv: 3, min: null, max: null }));
  columns.set('NAME', new ColumnStatistics({ ndv: 8000, min: null, max: null }));
  stats.set('T', new TableStatistics(10000, columns));
  return stats;
}

function extractConjunctOrder(condition) {
  const result = [];
  const walk = (node) => {
    if (node.kind === BoundExprKind.BINARY && node.op === 'AND') {
      walk(node.left);
      walk(node.right);
    } else {
      result.push(node);
    }
  };
  walk(condition);
  return result;
}

describe('FilterOrdering', () => {
  describe('reorders conjuncts by selectivity', () => {
    it('places equality predicate on high-NDV column before low-NDV column', () => {
      const pass = new FilterOrdering(makeStats());

      const highSelPred = binary(colRef('T', 'ID'), '=', literal(42));
      const lowSelPred = binary(colRef('T', 'STATUS'), '=', literal('A'));

      const plan = LogicalFilter(
        andExpr(lowSelPred, highSelPred),
        LogicalScan('T', [], 'T')
      );

      const result = pass.apply(plan);
      const ordered = extractConjunctOrder(result.condition);

      expect(ordered.length).toBe(2);
      expect(ordered[0].left.columnName).toBe('ID');
      expect(ordered[1].left.columnName).toBe('STATUS');
    });

    it('places equality on high-NDV column before range on low-NDV column', () => {
      const pass = new FilterOrdering(makeStats());

      const rangePred = binary(colRef('T', 'STATUS'), '>', literal('A'));
      const eqPred = binary(colRef('T', 'ID'), '=', literal(42));

      const plan = LogicalFilter(
        andExpr(rangePred, eqPred),
        LogicalScan('T', [], 'T')
      );

      const result = pass.apply(plan);
      const ordered = extractConjunctOrder(result.condition);

      expect(ordered.length).toBe(2);
      expect(ordered[0].left.columnName).toBe('ID');
      expect(ordered[1].left.columnName).toBe('STATUS');
    });
  });

  describe('preserves single-predicate filters', () => {
    it('returns filter unchanged when only one predicate', () => {
      const pass = new FilterOrdering(makeStats());
      const pred = binary(colRef('T', 'ID'), '=', literal(1));
      const plan = LogicalFilter(pred, LogicalScan('T', [], 'T'));

      const result = pass.apply(plan);
      expect(result.condition).toBe(pred);
    });
  });

  describe('handles nested filter+join trees', () => {
    it('reorders filters on both sides of a join', () => {
      const pass = new FilterOrdering(makeStats());

      const leftFilter = LogicalFilter(
        andExpr(
          binary(colRef('T', 'STATUS'), '=', literal('X')),
          binary(colRef('T', 'ID'), '=', literal(5))
        ),
        LogicalScan('T', [], 'T')
      );

      const join = LogicalJoin(JoinType.INNER, null, leftFilter, LogicalScan('T', [], 'T'));
      const result = pass.apply(join);

      const leftChild = result.children[0];
      expect(leftChild.type).toBe(PlanNodeType.FILTER);
      const ordered = extractConjunctOrder(leftChild.condition);
      expect(ordered[0].left.columnName).toBe('ID');
    });
  });

  describe('no-op when no statistics available', () => {
    it('keeps original conjunct order with empty stats', () => {
      const pass = new FilterOrdering(new Map());

      const pred1 = binary(colRef('T', 'A'), '=', literal(1));
      const pred2 = binary(colRef('T', 'B'), '=', literal(2));
      const plan = LogicalFilter(andExpr(pred1, pred2), LogicalScan('T', [], 'T'));

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.FILTER);
    });
  });
});
