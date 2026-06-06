import { describe, it, expect } from 'vitest';
import { JoinElimination } from '../../../src/optimizer/passes/join-elimination.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
  LogicalJoin,
  LogicalAggregate,
  LogicalSort,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new JoinElimination();

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
  return LogicalScan(name, ['id', 'name'], name);
}

describe('JoinElimination', () => {
  describe('LEFT JOIN elimination', () => {
    it('eliminates LEFT JOIN when right side columns are unused in PROJECT', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalProject(
        [colRef('a', 'id'), colRef('a', 'name')],
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
      expect(result.children[0].table).toBe('a');
    });

    it('keeps LEFT JOIN when right side columns are used in PROJECT', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalProject(
        [colRef('a', 'id'), colRef('b', 'name')],
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('FILTER parent', () => {
    it('eliminates LEFT JOIN when right side is unused in FILTER', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('a', 'id'), '>', lit(0)),
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
      expect(result.children[0].table).toBe('a');
    });

    it('keeps LEFT JOIN when right side is used in FILTER condition', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalFilter(
        bin(colRef('b', 'name'), '=', lit('test')),
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('AGGREGATE parent', () => {
    it('eliminates LEFT JOIN when right side is unused in aggregation', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalAggregate(
        [colRef('a', 'id')],
        [{ fn: 'COUNT', args: [colRef('a', 'name')] }],
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
      expect(result.children[0].table).toBe('a');
    });

    it('keeps LEFT JOIN when right column is in GROUP BY', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalAggregate(
        [colRef('b', 'name')],
        [{ fn: 'COUNT', args: [colRef('a', 'id')] }],
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
    });

    it('keeps LEFT JOIN when right column is in aggregate args', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalAggregate(
        [colRef('a', 'id')],
        [{ fn: 'SUM', args: [colRef('b', 'name')] }],
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('SORT parent', () => {
    it('eliminates LEFT JOIN when right side is unused in ORDER BY', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalSort(
        [{ expr: colRef('a', 'id'), direction: 'ASC' }],
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SORT);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
      expect(result.children[0].table).toBe('a');
    });

    it('keeps LEFT JOIN when right side is used in ORDER BY', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalSort(
        [{ expr: colRef('b', 'name'), direction: 'ASC' }],
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SORT);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('INNER JOIN is not eliminated', () => {
    it('does not eliminate INNER JOIN even when right side is unused', () => {
      const join = LogicalJoin(
        JoinType.INNER,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const plan = LogicalProject(
        [colRef('a', 'id')],
        join
      );

      const result = pass.apply(plan);

      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('no join child', () => {
    it('passes through plan with no join', () => {
      const plan = LogicalProject(
        [colRef('t', 'id')],
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('nested elimination', () => {
    it('eliminates LEFT JOIN nested deeper in the tree', () => {
      const innerJoin = LogicalJoin(
        JoinType.LEFT,
        bin(colRef('a', 'id'), '=', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );
      const outerProject = LogicalProject(
        [colRef('a', 'id')],
        innerJoin
      );
      const plan = LogicalFilter(
        bin(colRef('a', 'id'), '>', lit(0)),
        outerProject
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      const proj = result.children[0];
      expect(proj.type).toBe(PlanNodeType.PROJECT);
      expect(proj.children[0].type).toBe(PlanNodeType.SCAN);
      expect(proj.children[0].table).toBe('a');
    });
  });
});
