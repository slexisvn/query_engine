import { describe, it, expect } from 'vitest';
import { NodeMerge } from '../../../src/optimizer/passes/node-merge.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
  LogicalLimit,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new NodeMerge();

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

describe('NodeMerge', () => {
  describe('FILTER merging', () => {
    it('merges two consecutive filters into one with AND', () => {
      const outer = bin(colRef('t', 'id'), '>', lit(0));
      const inner = bin(colRef('t', 'status'), '=', lit('active'));

      const plan = LogicalFilter(
        outer,
        LogicalFilter(inner, scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.condition.op).toBe('AND');
      expect(result.condition.left).toBe(outer);
      expect(result.condition.right).toBe(inner);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('merges three consecutive filters into one', () => {
      const p1 = bin(colRef('t', 'id'), '>', lit(0));
      const p2 = bin(colRef('t', 'status'), '=', lit('A'));
      const p3 = bin(colRef('t', 'val'), '<', lit(100));

      const plan = LogicalFilter(
        p1,
        LogicalFilter(p2, LogicalFilter(p3, scan('t')))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('does not merge filter over non-filter child', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'id'), '>', lit(0)),
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('PROJECT merging', () => {
    it('merges identical consecutive projections', () => {
      const exprs = [colRef('t', 'id'), colRef('t', 'val')];

      const plan = LogicalProject(
        exprs,
        LogicalProject(exprs, scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('does not merge projections with different expressions', () => {
      const plan = LogicalProject(
        [colRef('t', 'id')],
        LogicalProject([colRef('t', 'id'), colRef('t', 'val')], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.PROJECT);
    });

    it('ignores outputName/alias differences when comparing', () => {
      const outer = [{ ...colRef('t', 'id'), outputName: 'user_id' }];
      const inner = [{ ...colRef('t', 'id'), outputName: 'id' }];

      const plan = LogicalProject(outer, LogicalProject(inner, scan('t')));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('LIMIT merging', () => {
    it('merges two limits taking the smaller count', () => {
      const plan = LogicalLimit(5, 0, LogicalLimit(10, 0, scan('t')));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.count).toBe(5);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('takes inner count when it is smaller', () => {
      const plan = LogicalLimit(100, 0, LogicalLimit(3, 0, scan('t')));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.count).toBe(3);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('merges three limits into one', () => {
      const plan = LogicalLimit(
        10, 0,
        LogicalLimit(5, 0, LogicalLimit(20, 0, scan('t')))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.count).toBe(5);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('mixed node types', () => {
    it('does not merge filter with project', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'id'), '>', lit(0)),
        LogicalProject([colRef('t', 'id')], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.PROJECT);
    });

    it('does not merge limit with filter', () => {
      const plan = LogicalLimit(
        10, 0,
        LogicalFilter(bin(colRef('t', 'id'), '>', lit(0)), scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].type).toBe(PlanNodeType.FILTER);
    });
  });

  describe('recursive merging', () => {
    it('merges at multiple levels in the tree', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'id'), '>', lit(0)),
        LogicalFilter(
          bin(colRef('t', 'status'), '=', lit('A')),
          LogicalLimit(10, 0, LogicalLimit(20, 0, scan('t')))
        )
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].count).toBe(10);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('plan without mergeable nodes', () => {
    it('returns plan unchanged', () => {
      const plan = LogicalProject(
        [colRef('t', 'id')],
        LogicalFilter(bin(colRef('t', 'id'), '>', lit(0)), scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });
});
