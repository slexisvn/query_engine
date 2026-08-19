import { describe, it, expect } from 'vitest';
import { HavingPushdown } from '../../../src/optimizer/passes/having-pushdown.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalFilter,
  LogicalAggregate,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new HavingPushdown();

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function lit(v) {
  return { kind: BoundExprKind.LITERAL, value: v };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function aggExpr(fn, args) {
  return { kind: BoundExprKind.AGGREGATE, fn, args };
}

function scan(name) {
  return LogicalScan(name, ['id', 'status', 'amount'], name);
}

function agg(groupBy, aggregates, child) {
  return LogicalAggregate(groupBy, aggregates, child);
}

describe('HavingPushdown', () => {
  describe('non-aggregate predicates', () => {
    it('pushes column predicate below aggregate', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'status'), '=', lit('active')),
        agg([colRef('t', 'status')], [aggExpr('COUNT', [])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].condition.left.columnName).toBe('status');
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('removes top-level filter when all predicates are pushed', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'status'), '=', lit('active')),
        agg([colRef('t', 'status')], [aggExpr('SUM', [colRef('t', 'amount')])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.AGGREGATE);
    });
  });

  describe('aggregate predicates', () => {
    it('keeps aggregate predicate above the aggregate', () => {
      const havingCond = bin(aggExpr('COUNT', []), '>', lit(5));
      const plan = LogicalFilter(
        havingCond,
        agg([colRef('t', 'status')], [aggExpr('COUNT', [])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
    });

    it('does not push SUM(...) > 100 below aggregate', () => {
      const sumPred = bin(aggExpr('SUM', [colRef('t', 'amount')]), '>', lit(100));
      const plan = LogicalFilter(
        sumPred,
        agg([colRef('t', 'status')], [aggExpr('SUM', [colRef('t', 'amount')])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('mixed predicates (pushable + unpushable)', () => {
    it('splits AND: pushes column part, keeps aggregate part', () => {
      const colPred = bin(colRef('t', 'status'), '=', lit('active'));
      const aggPred = bin(aggExpr('COUNT', []), '>', lit(5));
      const combined = bin(colPred, 'AND', aggPred);

      const plan = LogicalFilter(
        combined,
        agg([colRef('t', 'status')], [aggExpr('COUNT', [])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].children[0].condition.left.columnName).toBe('status');
    });

    it('top filter retains only aggregate predicates after split', () => {
      const colPred = bin(colRef('t', 'status'), '=', lit('active'));
      const aggPred = bin(aggExpr('SUM', [colRef('t', 'amount')]), '>', lit(1000));
      const combined = bin(colPred, 'AND', aggPred);

      const plan = LogicalFilter(
        combined,
        agg([colRef('t', 'status')], [aggExpr('SUM', [colRef('t', 'amount')])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      const topCond = result.condition;
      expect(topCond.left.kind).toBe(BoundExprKind.AGGREGATE);
    });
  });

  describe('multiple pushable predicates', () => {
    it('pushes all non-aggregate predicates below', () => {
      const pred1 = bin(colRef('t', 'status'), '=', lit('active'));
      const pred2 = bin(colRef('t', 'amount'), '>', lit(0));
      const combined = bin(pred1, 'AND', pred2);

      const plan = LogicalFilter(
        combined,
        agg([colRef('t', 'status')], [aggExpr('COUNT', [])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.AGGREGATE);
      expect(result.children[0].type).toBe(PlanNodeType.FILTER);
    });
  });

  describe('non-aggregate child', () => {
    it('does not push when child is not an aggregate', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'status'), '=', lit('active')),
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('nested aggregate in predicate', () => {
    it('detects aggregate inside binary expression', () => {
      const pred = bin(
        bin(aggExpr('COUNT', []), '*', lit(2)),
        '>',
        lit(10)
      );
      const plan = LogicalFilter(
        pred,
        agg([colRef('t', 'status')], [aggExpr('COUNT', [])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
    });

    it('detects aggregate inside unary expression', () => {
      const pred = {
        kind: BoundExprKind.UNARY,
        op: 'NOT',
        operand: bin(aggExpr('COUNT', []), '=', lit(0)),
      };
      const plan = LogicalFilter(
        pred,
        agg([colRef('t', 'status')], [aggExpr('COUNT', [])], scan('t'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
    });
  });

  describe('recursive rewriting', () => {
    it('rewrites nested filter-over-aggregate patterns', () => {
      const innerAgg = agg([colRef('t', 'status')], [aggExpr('COUNT', [])], scan('t'));
      const innerFilter = LogicalFilter(
        bin(colRef('t', 'status'), '=', lit('A')),
        innerAgg
      );
      const outerAgg = agg([colRef('t', 'status')], [aggExpr('SUM', [colRef('t', 'amount')])], innerFilter);
      const plan = LogicalFilter(
        bin(colRef('t', 'status'), '=', lit('B')),
        outerAgg
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.AGGREGATE);
    });
  });
});
