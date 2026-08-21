import { describe, it, expect } from 'vitest';
import { SortElimination, cteScanOrderRequirements } from '../../../src/optimizer/passes/sort-elimination.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalSort,
  LogicalFilter,
  LogicalProject,
  LogicalAggregate,
  LogicalLimit,
  LogicalTopN,
  LogicalWindow,
  LogicalCTEScan,
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
  describe('sorts whose order nobody observes', () => {
    function project(child) {
      return LogicalProject([{ expr: colRef('t', 'id'), alias: 'id' }], child);
    }
    function aggregate(child) {
      return LogicalAggregate([], [], child);
    }
    function sortOn(key, child) {
      return LogicalSort([{ expr: colRef('t', key), direction: 'ASC' }], child);
    }
    function countSorts(n) {
      if (!n) return 0;
      let count = n.type === PlanNodeType.SORT ? 1 : 0;
      for (const c of n.children || []) count += countSorts(c);
      return count;
    }

    it('removes a SORT feeding an aggregate that discards row order', () => {
      const result = pass.apply(aggregate(sortOn('val', scan('t'))));

      expect(countSorts(result)).toBe(0);
    });

    it('removes a SORT separated from the aggregate by a projection', () => {
      const result = pass.apply(aggregate(project(sortOn('val', scan('t')))));

      expect(countSorts(result)).toBe(0);
    });

    it('removes a SORT under a TopN that re-orders on its own keys', () => {
      const inner = sortOn('val', scan('t'));
      const plan = LogicalTopN([{ expr: colRef('t', 'id'), direction: 'ASC' }], 5, 0, inner);

      const result = pass.apply(plan);

      expect(countSorts(result)).toBe(0);
      expect(result.type).toBe(PlanNodeType.TOP_N);
    });

    it('keeps the SORT that produces the result order of the query', () => {
      const result = pass.apply(project(sortOn('val', scan('t'))));

      expect(countSorts(result)).toBe(1);
    });

    it('keeps a SORT under a LIMIT because it decides which rows survive', () => {
      const result = pass.apply(aggregate(LogicalLimit(10, 0, sortOn('val', scan('t')))));

      expect(countSorts(result)).toBe(1);
    });

    it('keeps a SORT that carries its own limit', () => {
      const sort = sortOn('val', scan('t'));
      sort.limit = 10;

      const result = pass.apply(aggregate(sort));

      expect(countSorts(result)).toBe(1);
    });

    it('keeps a SORT under a window function whose result depends on row order', () => {
      const result = pass.apply(aggregate(LogicalWindow([], sortOn('val', scan('t')))));

      expect(countSorts(result)).toBe(1);
    });

    it('clears the stale sort property on nodes above a removed SORT', () => {
      const inner = project(sortOn('val', scan('t')));
      inner._sortedBy = [{ key: 'T.VAL', direction: 'ASC' }];

      const result = pass.apply(aggregate(inner));

      expect(countSorts(result)).toBe(0);
      expect(result.children[0]._sortedBy).toBeUndefined();
    });

    it('removes a root SORT when the context says the order is not observed', () => {
      const plan = project(sortOn('val', scan('t')));

      const result = pass.apply(plan, { rootOrderRequired: false });

      expect(countSorts(result)).toBe(0);
    });
  });

  describe('cteScanOrderRequirements', () => {
    it('reports order as not required for a CTE consumed by an aggregate', () => {
      const plan = LogicalAggregate([], [], LogicalCTEScan('D', 1, 'D'));

      expect(cteScanOrderRequirements(plan).get('D')).toBe(false);
    });

    it('reports order as required for a CTE consumed at the query root', () => {
      const plan = LogicalProject([{ expr: colRef('d', 'id'), alias: 'id' }], LogicalCTEScan('D', 1, 'D'));

      expect(cteScanOrderRequirements(plan).get('D')).toBe(true);
    });

    it('requires order when any one of several consumers requires it', () => {
      const requirements = cteScanOrderRequirements(LogicalAggregate([], [], LogicalCTEScan('D', 1, 'D')));
      cteScanOrderRequirements(LogicalProject([{ expr: colRef('d', 'id'), alias: 'id' }], LogicalCTEScan('D', 1, 'D')), requirements);

      expect(requirements.get('D')).toBe(true);
    });

    it('reports order as not required for a CTE the outer query re-sorts', () => {
      const plan = LogicalSort([{ expr: colRef('d', 'id'), direction: 'ASC' }], LogicalCTEScan('D', 1, 'D'));

      expect(cteScanOrderRequirements(plan).get('D')).toBe(false);
    });
  });
});
