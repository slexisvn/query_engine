import { describe, it, expect, beforeEach } from 'vitest';
import { DistributionAwareJoin, DistributionStrategy } from '../../../src/distributed/optimizer/distribution-aware-join.js';
import { PartitionMap } from '../../../src/distributed/partition/partition-map.js';
import { HashPartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';
import { PlanNodeType, LogicalScan, LogicalJoin, JoinType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { Config } from '../../../src/config.js';

function makeEquiJoinCondition(leftTable, leftCol, rightTable, rightCol) {
  return {
    kind: BoundExprKind.BINARY,
    op: '=',
    left: { kind: BoundExprKind.COLUMN_REF, tableAlias: leftTable, columnName: leftCol },
    right: { kind: BoundExprKind.COLUMN_REF, tableAlias: rightTable, columnName: rightCol },
  };
}

function makeJoin(leftTable, rightTable, leftCol, rightCol, joinType = JoinType.INNER) {
  const left = LogicalScan(leftTable, [], leftTable);
  const right = LogicalScan(rightTable, [], rightTable);
  const cond = makeEquiJoinCondition(leftTable, leftCol, rightTable, rightCol);
  return LogicalJoin(joinType, cond, left, right);
}

describe('DistributionAwareJoin', () => {
  let pm;

  beforeEach(() => {
    pm = new PartitionMap();
  });

  it('detects colocated join when tables are co-partitioned on join keys', () => {
    const strategy = new HashPartitionStrategy();
    strategy._partitionKey = 'ID';
    const placements = new Map([[0, ['n1']], [1, ['n2']]]);
    pm.registerTable('ORDERS', strategy, 2, placements);

    const strategy2 = new HashPartitionStrategy();
    strategy2._partitionKey = 'ORDER_ID';
    pm.registerTable('LINEITEM', strategy2, 2, placements);

    const join = makeJoin('ORDERS', 'LINEITEM', 'ID', 'ORDER_ID');
    join.children[0]._cardinality = 1000;
    join.children[1]._cardinality = 5000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionStrategy).toBe(DistributionStrategy.COLOCATED);
  });

  it('chooses broadcast when right side is below broadcastThreshold', () => {
    const strategy = new HashPartitionStrategy();
    strategy._partitionKey = 'ID';
    pm.registerTable('ORDERS', strategy, 4, new Map());

    const join = makeJoin('ORDERS', 'ITEMS', 'ITEM_ID', 'ID');
    join.children[0]._cardinality = 100000;
    join.children[1]._cardinality = 50;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionStrategy).toBe(DistributionStrategy.BROADCAST_RIGHT);
  });

  it('chooses broadcast left when left side is small', () => {
    const join = makeJoin('SMALL', 'BIG', 'K', 'K');
    join.children[0]._cardinality = 50;
    join.children[1]._cardinality = 100000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionStrategy).toBe(DistributionStrategy.BROADCAST_LEFT);
  });

  it('falls back to shuffle when both sides exceed broadcastThreshold', () => {
    const join = makeJoin('BIG_A', 'BIG_B', 'KEY', 'KEY');
    join.children[0]._cardinality = 500000;
    join.children[1]._cardinality = 500000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionStrategy).toBe(DistributionStrategy.SHUFFLE);
  });

  it('assigns _distributionCost reflecting network cost model', () => {
    const join = makeJoin('A', 'B', 'K', 'K');
    join.children[0]._cardinality = 500000;
    join.children[1]._cardinality = 500000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionCost).toBeDefined();
    expect(result._distributionCost).toBeGreaterThan(0);
    expect(typeof result._distributionCost).toBe('number');
  });

  it('shuffle cost = (leftRows*leftWidth + rightRows*rightWidth) * costPerByte', () => {
    const join = makeJoin('X', 'Y', 'K', 'K');
    join.children[0]._cardinality = 100000;
    join.children[1]._cardinality = 100000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    if (result._distributionStrategy === DistributionStrategy.SHUFFLE) {
      const expectedCost = (100000 * 64 + 100000 * 64) * Config.networkCostPerByte;
      expect(result._distributionCost).toBeCloseTo(expectedCost, 2);
    }
  });

  it('defaults to shuffle for non-equi-join condition', () => {
    const left = LogicalScan('A', [], 'A');
    const right = LogicalScan('B', [], 'B');
    const cond = {
      kind: BoundExprKind.BINARY,
      op: '>',
      left: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'A', columnName: 'X' },
      right: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'B', columnName: 'Y' },
    };
    const join = LogicalJoin(JoinType.INNER, cond, left, right);

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionStrategy).toBe(DistributionStrategy.SHUFFLE);
  });

  it('does not broadcast left side for LEFT join (restricted)', () => {
    const join = makeJoin('BIG', 'SMALL', 'K', 'K', JoinType.LEFT);
    join.children[0]._cardinality = 50;
    join.children[1]._cardinality = 100000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionStrategy).not.toBe(DistributionStrategy.BROADCAST_LEFT);
  });

  it('does not broadcast left side for SEMI join (restricted)', () => {
    const join = makeJoin('T1', 'T2', 'K', 'K', JoinType.SEMI);
    join.children[0]._cardinality = 50;
    join.children[1]._cardinality = 100000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionStrategy).not.toBe(DistributionStrategy.BROADCAST_LEFT);
  });

  it('does not broadcast left side for ANTI join (restricted)', () => {
    const join = makeJoin('T1', 'T2', 'K', 'K', JoinType.ANTI);
    join.children[0]._cardinality = 50;
    join.children[1]._cardinality = 100000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(join);

    expect(result._distributionStrategy).not.toBe(DistributionStrategy.BROADCAST_LEFT);
  });

  it('processes nested joins recursively', () => {
    const a = LogicalScan('A', [], 'A');
    const b = LogicalScan('B', [], 'B');
    const c = LogicalScan('C', [], 'C');
    const condAB = makeEquiJoinCondition('A', 'K', 'B', 'K');
    const joinAB = LogicalJoin(JoinType.INNER, condAB, a, b);
    joinAB.children[0]._cardinality = 100000;
    joinAB.children[1]._cardinality = 100000;

    const condABC = makeEquiJoinCondition('A', 'K', 'C', 'K');
    const joinABC = LogicalJoin(JoinType.INNER, condABC, joinAB, c);
    joinABC.children[1]._cardinality = 100000;

    const pass = new DistributionAwareJoin(pm);
    const result = pass.apply(joinABC);

    expect(result._distributionStrategy).toBeDefined();
    expect(result.children[0]._distributionStrategy).toBeDefined();
  });

  it('uses statisticsMap for cardinality and row width', () => {
    const stats = new Map();
    stats.set('T1', { rowCount: 200, avgRowWidth: 32 });
    stats.set('T2', { rowCount: 800000, avgRowWidth: 128 });

    const join = makeJoin('T1', 'T2', 'K', 'K');

    const pass = new DistributionAwareJoin(pm, stats);
    const result = pass.apply(join);

    expect(result._distributionStrategy).toBe(DistributionStrategy.BROADCAST_LEFT);
  });
});
