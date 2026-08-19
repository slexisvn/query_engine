import { describe, it, expect } from 'vitest';
import { CTEOptimization } from '../../../src/optimizer/passes/cte-optimization.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
  LogicalCTEScan,
  LogicalCTEAnchor,
  LogicalUnion,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new CTEOptimization();

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function literal(v) {
  return { kind: BoundExprKind.LITERAL, value: v };
}

function eq(left, right) {
  return { kind: BoundExprKind.BINARY, op: '=', left, right };
}

describe('CTEOptimization', () => {
  describe('CTE anchor removal', () => {
    it('removes the CTE_ANCHOR node from the tree', () => {
      const producer = LogicalScan('orders', ['id', 'total'], 'orders');
      const consumer = LogicalFilter(
        eq(colRef('orders', 'total'), literal(100)),
        LogicalCTEScan('my_cte', 1)
      );
      const plan = LogicalCTEAnchor('my_cte', 1, producer, consumer);

      const result = pass.apply(plan);

      expect(result.type).not.toBe(PlanNodeType.CTE_ANCHOR);
      expect(result.type).toBe(PlanNodeType.FILTER);
    });

    it('returns consumer subtree as root', () => {
      const producer = LogicalScan('src', ['col'], 'src');
      const consumer = LogicalProject(
        [colRef('cte', 'col')],
        LogicalCTEScan('c', 1)
      );
      const plan = LogicalCTEAnchor('c', 1, producer, consumer);

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.PROJECT);
    });
  });

  describe('single-reference CTE (count=1)', () => {
    it('does not wrap producer in Materialize', () => {
      const producer = LogicalScan('t', ['x'], 't');
      const consumer = LogicalCTEScan('once', 1);
      const plan = LogicalCTEAnchor('once', 1, producer, consumer);

      const result = pass.apply(plan);
      expect(result.type).not.toBe(PlanNodeType.MATERIALIZE);
    });
  });

  describe('multi-reference CTE (count>1)', () => {
    it('wraps producer in Materialize for multi-ref CTE', () => {
      const producer = LogicalScan('expensive', ['a', 'b'], 'expensive');
      const scan1 = LogicalCTEScan('shared', 1);
      const scan2 = LogicalCTEScan('shared', 1);
      const consumer = LogicalUnion(scan1, scan2, true);
      const plan = LogicalCTEAnchor('shared', 1, producer, consumer);

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.UNION);
    });
  });

  describe('nested CTEs', () => {
    it('inner CTE anchor is also removed', () => {
      const innerProducer = LogicalScan('inner_t', ['a'], 'inner_t');
      const innerConsumer = LogicalCTEScan('inner', 2);
      const innerAnchor = LogicalCTEAnchor('inner', 2, innerProducer, innerConsumer);

      const outerProducer = LogicalScan('outer_t', ['b'], 'outer_t');
      const plan = LogicalCTEAnchor('outer', 1, outerProducer, innerAnchor);

      const result = pass.apply(plan);

      expect(result.type).not.toBe(PlanNodeType.CTE_ANCHOR);
    });

    it('inner CTE scan replacement works for nested CTEs', () => {
      const innerProducer = LogicalScan('data', ['x'], 'data');
      const innerScan = LogicalCTEScan('inner_cte', 2);

      const outerProducer = LogicalCTEAnchor(
        'inner_cte', 2, innerProducer, innerScan
      );
      const outerConsumer = LogicalCTEScan('outer_cte', 1);
      const plan = LogicalCTEAnchor('outer_cte', 1, outerProducer, outerConsumer);

      const result = pass.apply(plan);
      expect(result.type).not.toBe(PlanNodeType.CTE_ANCHOR);
    });
  });

  describe('case insensitivity', () => {
    it('counts CTE references case-insensitively', () => {
      const producer = LogicalScan('t', ['x'], 't');
      const scan1 = LogicalCTEScan('MyCte', 1);
      const scan2 = LogicalCTEScan('MYCTE', 1);
      const consumer = LogicalUnion(scan1, scan2, true);
      const plan = LogicalCTEAnchor('mycte', 1, producer, consumer);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.UNION);
    });
  });

  describe('unreferenced CTE', () => {
    it('returns consumer when CTE is never scanned', () => {
      const producer = LogicalScan('unused', ['x'], 'unused');
      const consumer = LogicalScan('main', ['y'], 'main');
      const plan = LogicalCTEAnchor('dead_cte', 1, producer, consumer);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SCAN);
      expect(result.table).toBe('main');
    });
  });

  describe('plan without CTE', () => {
    it('passes through a plan with no CTE nodes unchanged', () => {
      const plan = LogicalFilter(
        eq(colRef('t', 'id'), literal(1)),
        LogicalScan('t', ['id', 'name'], 't')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('ref counting', () => {
    it('three references counts as multi-ref', () => {
      const producer = LogicalScan('t', ['id'], 't');
      const s1 = LogicalCTEScan('tri', 1);
      const s2 = LogicalCTEScan('tri', 1);
      const s3 = LogicalCTEScan('tri', 1);
      const union12 = LogicalUnion(s1, s2, true);
      const consumer = LogicalUnion(union12, s3, true);
      const plan = LogicalCTEAnchor('tri', 1, producer, consumer);

      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.UNION);
    });
  });

  describe('producer rewriting', () => {
    it('recursively rewrites producer subtree', () => {
      const innerProd = LogicalScan('base', ['id'], 'base');
      const innerCons = LogicalCTEScan('inner', 2);
      const producer = LogicalCTEAnchor('inner', 2, innerProd, innerCons);

      const consumer = LogicalCTEScan('outer', 1);
      const plan = LogicalCTEAnchor('outer', 1, producer, consumer);

      const result = pass.apply(plan);
      expect(result.type).not.toBe(PlanNodeType.CTE_ANCHOR);
    });
  });
});
