import { describe, it, expect } from 'vitest';
import { AggregatePushdown } from '../../../src/optimizer/passes/aggregate-pushdown.js';
import { PlanNodeType, LogicalAggregate, LogicalJoin, LogicalScan, JoinType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function colRef(table, column) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column };
}

function literal(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function eqJoinCond(leftTable, leftCol, rightTable, rightCol) {
  return {
    kind: BoundExprKind.BINARY,
    op: '=',
    left: colRef(leftTable, leftCol),
    right: colRef(rightTable, rightCol),
  };
}

function makeAgg(func, args, outputName, opts = {}) {
  return { func, functionName: func, args, outputName, ...opts };
}

function makeInnerJoin(condition, leftTable, rightTable) {
  return LogicalJoin(
    JoinType.INNER,
    condition,
    LogicalScan(leftTable, [], leftTable),
    LogicalScan(rightTable, [], rightTable)
  );
}

describe('AggregatePushdown', () => {
  const pass = new AggregatePushdown();

  describe('pushes decomposable aggregates below inner join', () => {
    it('pushes SUM aggregate when group-by is on left side', () => {
      const join = makeInnerJoin(eqJoinCond('A', 'id', 'B', 'a_id'), 'A', 'B');
      const plan = LogicalAggregate(
        [colRef('A', 'category')],
        [makeAgg('SUM', [colRef('A', 'amount')], 'total')],
        join
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.AGGREGATE);
      const innerJoin = result.children[0];
      expect(innerJoin.type).toBe(PlanNodeType.JOIN);
      const partialAgg = innerJoin.children[0];
      expect(partialAgg.type).toBe(PlanNodeType.AGGREGATE);
      expect(partialAgg.aggregates[0].func).toBe('SUM');
      expect(partialAgg.aggregates[0]._isPartial).toBe(true);
    });

    it('pushes COUNT and converts final to SUM', () => {
      const join = makeInnerJoin(eqJoinCond('A', 'id', 'B', 'a_id'), 'A', 'B');
      const plan = LogicalAggregate(
        [colRef('A', 'category')],
        [makeAgg('COUNT', [literal(1)], 'cnt')],
        join
      );

      const result = pass.apply(plan);
      const finalAggs = result.aggregates;
      expect(finalAggs[0].func).toBe('SUM');
      expect(finalAggs[0]._isFinal).toBe(true);

      const partialAgg = result.children[0].children[0];
      expect(partialAgg.aggregates[0].func).toBe('COUNT');
    });

    it('pushes MIN and MAX preserving function names', () => {
      const join = makeInnerJoin(eqJoinCond('A', 'id', 'B', 'a_id'), 'A', 'B');
      const plan = LogicalAggregate(
        [colRef('A', 'status')],
        [
          makeAgg('MIN', [colRef('A', 'val')], 'min_val'),
          makeAgg('MAX', [colRef('A', 'val')], 'max_val'),
        ],
        join
      );

      const result = pass.apply(plan);
      const partialAgg = result.children[0].children[0];
      expect(partialAgg.aggregates[0].func).toBe('MIN');
      expect(partialAgg.aggregates[1].func).toBe('MAX');
      expect(result.aggregates[0].func).toBe('MIN');
      expect(result.aggregates[1].func).toBe('MAX');
    });
  });

  describe('skips non-decomposable aggregates', () => {
    it('skips GROUP_CONCAT', () => {
      const join = makeInnerJoin(eqJoinCond('A', 'id', 'B', 'a_id'), 'A', 'B');
      const plan = LogicalAggregate(
        [colRef('A', 'category')],
        [makeAgg('GROUP_CONCAT', [colRef('A', 'name')], 'names')],
        join
      );

      const result = pass.apply(plan);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('skips DISTINCT aggregates', () => {
    it('does not push COUNT DISTINCT', () => {
      const join = makeInnerJoin(eqJoinCond('A', 'id', 'B', 'a_id'), 'A', 'B');
      const plan = LogicalAggregate(
        [colRef('A', 'category')],
        [makeAgg('COUNT', [colRef('A', 'val')], 'cnt', { distinct: true })],
        join
      );

      const result = pass.apply(plan);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('skips when group-by columns span both join sides', () => {
    it('does not push when grouping by columns from both tables', () => {
      const join = makeInnerJoin(eqJoinCond('A', 'id', 'B', 'a_id'), 'A', 'B');
      const plan = LogicalAggregate(
        [colRef('A', 'category'), colRef('B', 'region')],
        [makeAgg('SUM', [colRef('A', 'amount')], 'total')],
        join
      );

      const result = pass.apply(plan);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('skips non-inner joins', () => {
    it('does not push through LEFT join', () => {
      const join = LogicalJoin(
        JoinType.LEFT,
        eqJoinCond('A', 'id', 'B', 'a_id'),
        LogicalScan('A', [], 'A'),
        LogicalScan('B', [], 'B')
      );
      const plan = LogicalAggregate(
        [colRef('A', 'category')],
        [makeAgg('SUM', [colRef('A', 'amount')], 'total')],
        join
      );

      const result = pass.apply(plan);
      expect(result.children[0].type).toBe(PlanNodeType.JOIN);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('pushes to right side when group-by is on right', () => {
    it('places partial aggregate on right child of join', () => {
      const join = makeInnerJoin(eqJoinCond('A', 'id', 'B', 'a_id'), 'A', 'B');
      const plan = LogicalAggregate(
        [colRef('B', 'region')],
        [makeAgg('SUM', [colRef('B', 'sales')], 'total')],
        join
      );

      const result = pass.apply(plan);
      const innerJoin = result.children[0];
      expect(innerJoin.children[0].type).toBe(PlanNodeType.SCAN);
      expect(innerJoin.children[1].type).toBe(PlanNodeType.AGGREGATE);
      expect(innerJoin.children[1].aggregates[0]._isPartial).toBe(true);
    });
  });
});
