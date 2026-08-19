import { describe, it, expect } from 'vitest';
import { LimitPushdown } from '../../../src/optimizer/passes/limit-pushdown.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalProject,
  LogicalSort,
  LogicalLimit,
  LogicalUnion,
  LogicalFilter,
  LogicalAggregate,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new LimitPushdown();

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

describe('LimitPushdown', () => {
  describe('LIMIT through PROJECT', () => {
    it('pushes LIMIT below PROJECT', () => {
      const plan = LogicalLimit(
        10, 0,
        LogicalProject([colRef('t', 'id')], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].count).toBe(10);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('preserves offset when pushing through PROJECT', () => {
      const plan = LogicalLimit(
        10, 5,
        LogicalProject([colRef('t', 'id')], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].count).toBe(10);
    });
  });

  describe('LIMIT through UNION ALL', () => {
    it('pushes LIMIT into both sides of UNION ALL', () => {
      const plan = LogicalLimit(
        10, 0,
        LogicalUnion(scan('a'), scan('b'), true)
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].type).toBe(PlanNodeType.SET_OP);

      const union = result.children[0];
      expect(union.children[0].type).toBe(PlanNodeType.LIMIT);
      expect(union.children[0].count).toBe(10);
      expect(union.children[1].type).toBe(PlanNodeType.LIMIT);
      expect(union.children[1].count).toBe(10);
    });

    it('keeps outer LIMIT after pushing into UNION ALL', () => {
      const plan = LogicalLimit(
        5, 0,
        LogicalUnion(scan('a'), scan('b'), true)
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.count).toBe(5);
    });

    it('does not push LIMIT into UNION DISTINCT', () => {
      const plan = LogicalLimit(
        10, 0,
        LogicalUnion(scan('a'), scan('b'), false)
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].type).toBe(PlanNodeType.SET_OP);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('LIMIT above SORT', () => {
    it('annotates SORT with limit info', () => {
      const plan = LogicalLimit(
        10, 0,
        LogicalSort([{ expr: colRef('t', 'id'), direction: 'ASC' }], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      const sort = result.children[0];
      expect(sort.type).toBe(PlanNodeType.SORT);
      expect(sort.limit).toBe(10);
    });

    it('annotates SORT with offset', () => {
      const plan = LogicalLimit(
        10, 5,
        LogicalSort([{ expr: colRef('t', 'id'), direction: 'ASC' }], scan('t'))
      );

      const result = pass.apply(plan);

      const sort = result.children[0];
      expect(sort.limit).toBe(10);
      expect(sort.offset).toBe(5);
    });
  });

  describe('non-pushable children', () => {
    it('does not push LIMIT through FILTER', () => {
      const plan = LogicalLimit(
        10, 0,
        LogicalFilter(bin(colRef('t', 'id'), '>', lit(0)), scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].type).toBe(PlanNodeType.FILTER);
    });

    it('does not push LIMIT through SCAN', () => {
      const plan = LogicalLimit(10, 0, scan('t'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('recursive pushdown', () => {
    it('pushes LIMIT through nested PROJECT layers', () => {
      const plan = LogicalLimit(
        5, 0,
        LogicalProject(
          [colRef('t', 'id')],
          LogicalProject([colRef('t', 'id'), colRef('t', 'val')], scan('t'))
        )
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      const inner = result.children[0];
      expect(inner.type).toBe(PlanNodeType.PROJECT);
      expect(inner.children[0].type).toBe(PlanNodeType.LIMIT);
      expect(inner.children[0].count).toBe(5);
    });
  });

  describe('plan without LIMIT', () => {
    it('passes through plan with no LIMIT nodes', () => {
      const plan = LogicalProject([colRef('t', 'id')], scan('t'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
    });
  });

  describe('LIMIT through AGGREGATE', () => {
    it('annotates aggregate with _limitHint when group-by is present', () => {
      const agg = LogicalAggregate(
        [colRef('t', 'id')],
        [{ func: 'COUNT', args: [], outputName: 'cnt' }],
        scan('t')
      );
      const plan = LogicalLimit(10, 0, agg);

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0]._limitHint).toBe(10);
    });

    it('does not annotate ungrouped aggregate', () => {
      const agg = LogicalAggregate(
        [],
        [{ func: 'COUNT', args: [], outputName: 'cnt' }],
        scan('t')
      );
      const plan = LogicalLimit(10, 0, agg);

      const result = pass.apply(plan);
      expect(result.children[0]._limitHint).toBeUndefined();
    });

    it('includes offset in _limitHint', () => {
      const agg = LogicalAggregate(
        [colRef('t', 'status')],
        [{ func: 'SUM', args: [colRef('t', 'val')], outputName: 'total' }],
        scan('t')
      );
      const plan = LogicalLimit(10, 5, agg);

      const result = pass.apply(plan);
      expect(result.children[0]._limitHint).toBe(15);
    });
  });
});
