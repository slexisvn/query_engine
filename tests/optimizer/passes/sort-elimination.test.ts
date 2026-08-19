import { describe, it, expect } from 'vitest';
import { SortElimination } from '../../../src/optimizer/passes/sort-elimination.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalSort,
  LogicalFilter,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new SortElimination();

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

function sortedScan(name, sortKeys) {
  const s = scan(name);
  s._sortedBy = sortKeys;
  return s;
}

describe('SortElimination', () => {
  describe('removes redundant sort', () => {
    it('eliminates SORT when child is already sorted on same key', () => {
      const child = sortedScan('t', ['T.ID']);
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        child
      );

      const result = pass.apply(plan);

      expect(result.type).not.toBe(PlanNodeType.SORT);
    });

    it('eliminates SORT when child sorted on prefix that covers requested keys', () => {
      const child = sortedScan('t', ['T.ID', 'T.VAL']);
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        child
      );

      const result = pass.apply(plan);

      expect(result.type).not.toBe(PlanNodeType.SORT);
    });
  });

  describe('keeps necessary sort', () => {
    it('keeps SORT when child has no sort order', () => {
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SORT);
    });

    it('keeps SORT when child is sorted on different key', () => {
      const child = sortedScan('t', ['T.VAL']);
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        child
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SORT);
    });

    it('keeps SORT when sort requires more keys than child provides', () => {
      const child = sortedScan('t', ['T.ID']);
      const plan = LogicalSort(
        [
          { expr: colRef('t', 'id'), direction: 'ASC' },
          { expr: colRef('t', 'val'), direction: 'ASC' },
        ],
        child
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SORT);
    });

    it('keeps SORT when child _sortedBy is empty array', () => {
      const child = sortedScan('t', []);
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        child
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SORT);
    });
  });

  describe('non-column-ref sort keys', () => {
    it('keeps SORT when order key is not a column reference', () => {
      const child = sortedScan('t', ['T.ID']);
      const plan = LogicalSort(
        [{ expr: bin(colRef('t', 'id'), '+', lit(1)), direction: 'ASC' }],
        child
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SORT);
    });
  });

  describe('recursive elimination', () => {
    it('eliminates inner redundant sort while keeping outer', () => {
      const child = sortedScan('t', ['T.ID']);
      const innerSort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        child
      );
      const outerSort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        innerSort
      );

      const result = pass.apply(outerSort);

      function countSorts(n) {
        if (!n) return 0;
        let count = n.type === PlanNodeType.SORT ? 1 : 0;
        for (const c of n.children || []) count += countSorts(c);
        return count;
      }
      expect(countSorts(result)).toBe(0);
    });
  });

  describe('column matching across relations', () => {
    it('keeps SORT when the child is sorted on the same column name of another relation', () => {
      const child = sortedScan('t', ['A.ID']);
      const plan = LogicalSort(
        [{ expr: colRef('b', 'id'), direction: 'ASC' }],
        child
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SORT);
    });

    it('eliminates SORT when the child order is recorded without a relation name', () => {
      const child = sortedScan('t', ['.ID']);
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        child
      );

      const result = pass.apply(plan);

      expect(result.type).not.toBe(PlanNodeType.SORT);
    });
  });

  describe('direction-aware elimination', () => {
    it('keeps SORT when child sorted ASC but query requires DESC', () => {
      const child = sortedScan('t', ['T.ID']);
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'DESC' }],
        child
      );

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.SORT);
    });

    it('eliminates SORT when child sorted with matching direction objects', () => {
      const s = scan('t');
      s._sortedBy = [{ key: 'T.ID', direction: 'DESC' }];
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'DESC' }],
        s
      );

      const result = pass.apply(plan);
      expect(result.type).not.toBe(PlanNodeType.SORT);
    });

    it('does NOT eliminate SORT when child is sorted in the opposite direction', () => {
      const s = scan('t');
      s._sortedBy = [{ key: 'T.ID', direction: 'DESC' }];
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        s
      );

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.SORT);
    });
  });
});
