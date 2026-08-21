import { describe, it, expect } from 'vitest';
import { DistinctElimination } from '../../../src/optimizer/passes/distinct-elimination.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalProject,
  LogicalFilter,
  LogicalAggregate,
  LogicalDistinct,
  LogicalSort,
  LogicalLimit,
  LogicalJoin,
  JoinType,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const catalog = {
  getTable(name) {
    if (name.toLowerCase() === 'users') return { primaryKey: ['id'] };
    return null;
  },
};

const pass = new DistinctElimination(catalog);
const passWithoutCatalog = new DistinctElimination();

function colRef(table, column, outputName) {
  const ref = { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column };
  return outputName ? { ...ref, outputName } : ref;
}

function scan() {
  return LogicalScan('users', [], 'u');
}

function groupedBy(...columns) {
  return LogicalAggregate(columns.map((column) => colRef('u', column)), [], scan());
}

function countDistincts(node) {
  if (!node) return 0;
  let count = node.type === PlanNodeType.DISTINCT ? 1 : 0;
  for (const child of node.children || []) count += countDistincts(child);
  return count;
}

describe('DistinctElimination', () => {
  describe('removes a redundant Distinct', () => {
    it('removes a Distinct directly over an aggregate', () => {
      const result = pass.apply(LogicalDistinct(groupedBy('city')));

      expect(countDistincts(result)).toBe(0);
      expect(result.type).toBe(PlanNodeType.AGGREGATE);
    });

    it('removes a Distinct over a projection of the group key', () => {
      const plan = LogicalDistinct(LogicalProject([colRef('u', 'city', 'city')], groupedBy('city')));

      expect(countDistincts(pass.apply(plan))).toBe(0);
    });

    it('removes a Distinct over a scalar aggregate', () => {
      expect(countDistincts(pass.apply(LogicalDistinct(groupedBy())))).toBe(0);
    });

    it('removes a Distinct over another Distinct', () => {
      const plan = LogicalDistinct(LogicalDistinct(scan()));

      expect(countDistincts(pass.apply(plan))).toBe(1);
    });

    it('removes a Distinct over a projection of a primary key', () => {
      const plan = LogicalDistinct(LogicalProject([colRef('u', 'id', 'id')], scan()));

      expect(countDistincts(pass.apply(plan))).toBe(0);
    });

    it('removes a Distinct separated from the aggregate by a filter', () => {
      const plan = LogicalDistinct(LogicalFilter(null, groupedBy('city')));

      expect(countDistincts(pass.apply(plan))).toBe(0);
    });

    it('removes a Distinct separated from the aggregate by a sort', () => {
      const sorted = LogicalSort([{ expr: colRef('u', 'city'), direction: 'ASC' }], groupedBy('city'));

      expect(countDistincts(pass.apply(LogicalDistinct(sorted)))).toBe(0);
    });

    it('removes a Distinct separated from the aggregate by a limit', () => {
      const plan = LogicalDistinct(LogicalLimit(10, 0, groupedBy('city')));

      expect(countDistincts(pass.apply(plan))).toBe(0);
    });

    it('removes a nested redundant Distinct below another node', () => {
      const inner = LogicalDistinct(groupedBy('city'));
      const plan = LogicalFilter(null, inner);

      expect(countDistincts(pass.apply(plan))).toBe(0);
    });
  });

  describe('keeps a Distinct that still removes duplicates', () => {
    it('keeps a Distinct over a bare scan', () => {
      expect(countDistincts(pass.apply(LogicalDistinct(scan())))).toBe(1);
    });

    it('keeps a Distinct over a projection that drops one of two group keys', () => {
      const plan = LogicalDistinct(LogicalProject([colRef('u', 'city', 'city')], groupedBy('city', 'year')));

      expect(countDistincts(pass.apply(plan))).toBe(1);
    });

    it('keeps a Distinct over a projection of a non-key column', () => {
      const plan = LogicalDistinct(LogicalProject([colRef('u', 'city', 'city')], scan()));

      expect(countDistincts(pass.apply(plan))).toBe(1);
    });

    it('keeps a Distinct over a join', () => {
      const join = LogicalJoin(JoinType.INNER, null, scan(), LogicalScan('orders', [], 'o'));

      expect(countDistincts(pass.apply(LogicalDistinct(join)))).toBe(1);
    });

    it('keeps a Distinct over a primary key when no catalog is available', () => {
      const plan = LogicalDistinct(LogicalProject([colRef('u', 'id', 'id')], scan()));

      expect(countDistincts(passWithoutCatalog.apply(plan))).toBe(1);
    });
  });

  describe('plans without a Distinct', () => {
    it('leaves a plan with no Distinct untouched', () => {
      const plan = LogicalProject([colRef('u', 'city', 'city')], scan());

      expect(pass.apply(plan)).toBe(plan);
    });
  });
});
