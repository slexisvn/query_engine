import { describe, it, expect } from 'vitest';
import { ProjectionPushdown } from '../../../src/optimizer/passes/projection-pushdown.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
  LogicalJoin,
  LogicalAggregate,
  LogicalSort,
  LogicalLimit,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new ProjectionPushdown();

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function lit(v) {
  return { kind: BoundExprKind.LITERAL, value: v };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function scanWith(name, cols) {
  return LogicalScan(name, cols.map(c => ({ name: c, columnName: c })), name);
}

describe('ProjectionPushdown', () => {
  describe('scan pruning', () => {
    it('removes unused columns from scan when project only uses subset', () => {
      const s = scanWith('t', ['id', 'name', 'age', 'email']);
      const plan = LogicalProject(
        [colRef('t', 'id'), colRef('t', 'name')],
        s
      );

      const result = pass.apply(plan);

      const scanNode = result.children[0];
      expect(scanNode.columns.length).toBeLessThan(4);
      const colNames = scanNode.columns.map(c => c.name || c.columnName);
      expect(colNames).toContain('id');
      expect(colNames).toContain('name');
    });

    it('keeps all columns when all are referenced', () => {
      const s = scanWith('t', ['id', 'val']);
      const plan = LogicalProject(
        [colRef('t', 'id'), colRef('t', 'val')],
        s
      );

      const result = pass.apply(plan);

      const scanNode = result.children[0];
      expect(scanNode.columns.length).toBe(2);
    });
  });

  describe('filter column tracking', () => {
    it('includes filter-referenced columns in required set', () => {
      const s = scanWith('t', ['id', 'name', 'age', 'email']);
      const filter = LogicalFilter(
        bin(colRef('t', 'age'), '>', lit(18)),
        s
      );
      const plan = LogicalProject(
        [colRef('t', 'id')],
        filter
      );

      const result = pass.apply(plan);

      function findScan(n) {
        if (!n) return null;
        if (n.type === PlanNodeType.SCAN) return n;
        for (const c of n.children || []) {
          const found = findScan(c);
          if (found) return found;
        }
        return null;
      }
      const scanNode = findScan(result);
      const colNames = scanNode.columns.map(c => c.name || c.columnName);
      expect(colNames).toContain('id');
      expect(colNames).toContain('age');
    });
  });

  describe('join column splitting', () => {
    it('pushes required columns to correct side of join', () => {
      const left = scanWith('a', ['id', 'name', 'extra']);
      const right = scanWith('b', ['id', 'val', 'unused']);
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        left,
        right
      );
      const plan = LogicalProject(
        [colRef('a', 'name'), colRef('b', 'val')],
        join
      );

      const result = pass.apply(plan);

      function findScans(n) {
        const scans = [];
        if (!n) return scans;
        if (n.type === PlanNodeType.SCAN) scans.push(n);
        for (const c of n.children || []) scans.push(...findScans(c));
        return scans;
      }
      const scans = findScans(result);
      const leftScan = scans.find(s => s.table === 'a');
      const rightScan = scans.find(s => s.table === 'b');

      const leftCols = leftScan.columns.map(c => c.name || c.columnName);
      const rightCols = rightScan.columns.map(c => c.name || c.columnName);

      expect(leftCols).toContain('id');
      expect(leftCols).toContain('name');
      expect(rightCols).toContain('id');
      expect(rightCols).toContain('val');
    });
  });

  describe('aggregate column tracking', () => {
    it('only requires group-by and aggregate argument columns from child', () => {
      const s = scanWith('t', ['id', 'status', 'amount', 'extra']);
      const plan = LogicalAggregate(
        [colRef('t', 'status')],
        [{ fn: 'SUM', args: [colRef('t', 'amount')] }],
        s
      );

      const result = pass.apply(plan);

      const scanNode = result.children[0];
      const colNames = scanNode.columns.map(c => c.name || c.columnName);
      expect(colNames).toContain('status');
      expect(colNames).toContain('amount');
      expect(colNames).not.toContain('extra');
    });
  });

  describe('sort column tracking', () => {
    it('includes sort key columns in required set', () => {
      const s = scanWith('t', ['id', 'name', 'age', 'extra']);
      const sort = LogicalSort(
        [{ expr: colRef('t', 'age'), direction: 'ASC' }],
        s
      );
      const plan = LogicalProject(
        [colRef('t', 'id')],
        sort
      );

      const result = pass.apply(plan);

      function findScan(n) {
        if (!n) return null;
        if (n.type === PlanNodeType.SCAN) return n;
        for (const c of n.children || []) {
          const found = findScan(c);
          if (found) return found;
        }
        return null;
      }
      const scanNode = findScan(result);
      const colNames = scanNode.columns.map(c => c.name || c.columnName);
      expect(colNames).toContain('id');
      expect(colNames).toContain('age');
    });
  });

  describe('limit passthrough', () => {
    it('pushes required columns through LIMIT unchanged', () => {
      const s = scanWith('t', ['id', 'name', 'extra']);
      const limit = LogicalLimit(10, 0, s);
      const plan = LogicalProject(
        [colRef('t', 'id')],
        limit
      );

      const result = pass.apply(plan);

      function findScan(n) {
        if (!n) return null;
        if (n.type === PlanNodeType.SCAN) return n;
        for (const c of n.children || []) {
          const found = findScan(c);
          if (found) return found;
        }
        return null;
      }
      const scanNode = findScan(result);
      const colNames = scanNode.columns.map(c => c.name || c.columnName);
      expect(colNames).toContain('id');
      expect(colNames).not.toContain('extra');
    });
  });

  describe('no pruning when all columns needed', () => {
    it('returns same plan when scan has no extra columns', () => {
      const s = scanWith('t', ['id']);
      const plan = LogicalProject([colRef('t', 'id')], s);

      const result = pass.apply(plan);

      expect(result.children[0].columns.length).toBe(1);
    });
  });

  describe('deeply nested pruning', () => {
    it('prunes through filter+join+sort chain', () => {
      const left = scanWith('a', ['id', 'name', 'extra1', 'extra2']);
      const right = scanWith('b', ['id', 'val']);
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        left,
        right
      );
      const filter = LogicalFilter(
        bin(colRef('b', 'val'), '>', lit(0)),
        join
      );
      const sort = LogicalSort(
        [{ expr: colRef('a', 'name'), direction: 'ASC' }],
        filter
      );
      const plan = LogicalProject(
        [colRef('a', 'name'), colRef('b', 'val')],
        sort
      );

      const result = pass.apply(plan);

      function findScans(n) {
        const scans = [];
        if (!n) return scans;
        if (n.type === PlanNodeType.SCAN) scans.push(n);
        for (const c of n.children || []) scans.push(...findScans(c));
        return scans;
      }
      const leftScan = findScans(result).find(s => s.table === 'a');
      const leftCols = leftScan.columns.map(c => c.name || c.columnName);
      expect(leftCols).not.toContain('extra1');
      expect(leftCols).not.toContain('extra2');
    });
  });

  describe('DISTINCT requires all input columns', () => {
    function findScan(n) {
      if (!n) return null;
      if (n.type === PlanNodeType.SCAN) return n;
      for (const c of n.children || []) {
        const found = findScan(c);
        if (found) return found;
      }
      return null;
    }

    it('does not prune scan columns below a DISTINCT even if the parent projects fewer', () => {
      const s = scanWith('t', ['a', 'b', 'k']);
      const distinct = { type: PlanNodeType.DISTINCT, children: [s] };
      const plan = LogicalProject([colRef('t', 'k')], distinct);

      const scanNode = findScan(pass.apply(plan));
      const cols = scanNode.columns.map(c => c.name || c.columnName);
      expect(cols).toContain('a');
      expect(cols).toContain('b');
      expect(cols).toContain('k');
    });
  });

  describe('passthrough node at plan root (null required)', () => {
    function findScan(n) {
      if (!n) return null;
      if (n.type === PlanNodeType.SCAN) return n;
      for (const c of n.children || []) {
        const found = findScan(c);
        if (found) return found;
      }
      return null;
    }

    function findScans(n, acc = []) {
      if (!n) return acc;
      if (n.type === PlanNodeType.SCAN) acc.push(n);
      for (const c of n.children || []) findScans(c, acc);
      return acc;
    }

    it('keeps all projected columns when SORT is the root', () => {
      const s = scanWith('t', ['id', 'name', 'extra']);
      const proj = LogicalProject([colRef('t', 'id'), colRef('t', 'name')], s);
      const sort = LogicalSort([{ expr: colRef('t', 'id'), direction: 'ASC' }], proj);

      const cols = findScan(pass.apply(sort)).columns.map(c => c.name || c.columnName);
      expect(cols).toContain('id');
      expect(cols).toContain('name');
    });

    it('keeps all projected columns when FILTER is the root', () => {
      const s = scanWith('t', ['id', 'name', 'extra']);
      const proj = LogicalProject([colRef('t', 'id'), colRef('t', 'name')], s);
      const filter = LogicalFilter(bin(colRef('t', 'id'), '>', lit(0)), proj);

      const cols = findScan(pass.apply(filter)).columns.map(c => c.name || c.columnName);
      expect(cols).toContain('id');
      expect(cols).toContain('name');
    });

    it('keeps both sides intact when JOIN is the root', () => {
      const left = scanWith('a', ['id', 'name']);
      const right = scanWith('b', ['id', 'val']);
      const join = LogicalJoin(JoinType.INNER, bin(colRef('a', 'id'), '=', colRef('b', 'id')), left, right);

      const result = pass.apply(join);
      const leftCols = findScans(result).find(s => s.table === 'a').columns.map(c => c.name || c.columnName);
      const rightCols = findScans(result).find(s => s.table === 'b').columns.map(c => c.name || c.columnName);
      expect(leftCols).toEqual(expect.arrayContaining(['id', 'name']));
      expect(rightCols).toEqual(expect.arrayContaining(['id', 'val']));
    });
  });

  describe('PROJECT node propagates child table aliases for join ref filtering', () => {
    it('preserves join key columns when right child is PROJECT over scan with different alias', () => {
      const left = scanWith('employees', ['id', 'name', 'dept_id']);
      const rightScan = scanWith('departments', ['id', 'budget']);
      const rightProject = LogicalProject(
        [colRef('departments', 'id')],
        rightScan
      );
      const join = LogicalJoin(
        JoinType.SEMI,
        bin(colRef('employees', 'dept_id'), '=', colRef('departments', 'id')),
        left,
        rightProject
      );
      const plan = LogicalProject(
        [colRef('employees', 'name')],
        join
      );

      const result = pass.apply(plan);

      function findScans(n) {
        const scans = [];
        if (!n) return scans;
        if (n.type === PlanNodeType.SCAN) scans.push(n);
        for (const c of n.children || []) scans.push(...findScans(c));
        return scans;
      }
      const empScan = findScans(result).find(s => s.table === 'employees');
      const empCols = empScan.columns.map(c => c.name || c.columnName);
      expect(empCols).toContain('name');
      expect(empCols).toContain('dept_id');
      expect(empCols).not.toContain('id');

      const deptScan = findScans(result).find(s => s.table === 'departments');
      const deptCols = deptScan.columns.map(c => c.name || c.columnName);
      expect(deptCols).toContain('id');
    });

    it('does not over-prune left scan when right PROJECT child shares column names', () => {
      const left = scanWith('orders', ['id', 'customer_id', 'total']);
      const rightScan = scanWith('customers', ['id', 'name']);
      const rightProject = LogicalProject(
        [colRef('customers', 'id')],
        rightScan
      );
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('orders', 'customer_id'), '=', colRef('customers', 'id')),
        left,
        rightProject
      );
      const plan = LogicalProject(
        [colRef('orders', 'total')],
        join
      );

      const result = pass.apply(plan);

      function findScans(n) {
        const scans = [];
        if (!n) return scans;
        if (n.type === PlanNodeType.SCAN) scans.push(n);
        for (const c of n.children || []) scans.push(...findScans(c));
        return scans;
      }
      const orderScan = findScans(result).find(s => s.table === 'orders');
      const orderCols = orderScan.columns.map(c => c.name || c.columnName);
      expect(orderCols).toContain('total');
      expect(orderCols).toContain('customer_id');
      expect(orderCols).not.toContain('id');
    });
  });
});
