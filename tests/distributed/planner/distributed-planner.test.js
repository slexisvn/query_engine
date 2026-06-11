import { describe, it, expect, beforeEach } from 'vitest';
import { DistributedPlanner } from '../../../src/distributed/planner/distributed-planner.js';
import { PartitionMap } from '../../../src/distributed/partition/partition-map.js';
import { HashPartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';
import { ClusterManager } from '../../../src/distributed/cluster/cluster-manager.js';
import { NodeDescriptor, NodeRole } from '../../../src/distributed/cluster/node-descriptor.js';
import { PlanNodeType, LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalAggregate, LogicalExchange, JoinType } from '../../../src/planner/logical-plan.js';
import { ExchangeType } from '../../../src/distributed/planner/fragment.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { resetFragmentIdCounter } from '../../../src/distributed/planner/fragment.js';

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function setupCluster() {
  const local = new NodeDescriptor({ nodeId: 'coord', host: '127.0.0.1', port: 9400, role: NodeRole.COORDINATOR });
  const cm = new ClusterManager(local, { heartbeatIntervalMs: 100000 });
  cm.addNode(new NodeDescriptor({ nodeId: 'w1', host: '127.0.0.1', port: 9401, role: NodeRole.WORKER }));
  cm.addNode(new NodeDescriptor({ nodeId: 'w2', host: '127.0.0.1', port: 9402, role: NodeRole.WORKER }));
  return cm;
}

function setupPartitionMap() {
  const pm = new PartitionMap();

  const stratOrders = new HashPartitionStrategy();
  stratOrders._partitionKey = 'ID';
  pm.registerTable('ORDERS', stratOrders, 4, new Map([
    [0, ['w1']], [1, ['w1']], [2, ['w2']], [3, ['w2']],
  ]));

  const stratLineitem = new HashPartitionStrategy();
  stratLineitem._partitionKey = 'ORDER_ID';
  pm.registerTable('LINEITEM', stratLineitem, 4, new Map([
    [0, ['w1']], [1, ['w1']], [2, ['w2']], [3, ['w2']],
  ]));

  return pm;
}

describe('DistributedPlanner', () => {
  let cm;
  let pm;

  beforeEach(() => {
    resetFragmentIdCounter();
    cm = setupCluster();
    pm = setupPartitionMap();
  });

  it('creates fragments for scan under exchange', () => {
    const scan = LogicalScan('ORDERS', ['ID', 'STATUS'], 'ORDERS');
    scan._cardinality = 10000;
    const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, scan);

    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(exchange);

    expect(plan.fragments.length).toBeGreaterThanOrEqual(3);
    expect(plan.getRootFragment()).toBeDefined();

    const leafs = plan.getLeafFragments();
    expect(leafs.length).toBe(2);
  });

  it('throws (does not silently run local) when a partitioned table has no available workers', () => {
    const localOnly = new NodeDescriptor({ nodeId: 'coord', host: '127.0.0.1', port: 9400, role: NodeRole.COORDINATOR });
    const emptyCluster = new ClusterManager(localOnly, { heartbeatIntervalMs: 100000 });
    const scan = LogicalScan('ORDERS', ['ID'], 'ORDERS');
    const planner = new DistributedPlanner(pm, emptyCluster);
    expect(() => planner.fragmentize(scan)).toThrow(/no workers are available/);
  });

  it('produces valid topological order', () => {
    const scan = LogicalScan('ORDERS', ['ID'], 'ORDERS');
    scan._cardinality = 1000;

    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(scan);
    const order = plan.topologicalOrder();

    expect(order.length).toBe(plan.fragments.length);

    const seen = new Set();
    for (const frag of order) {
      for (const input of frag.exchangeInputs) {
        expect(seen.has(input.sourceFragmentId)).toBe(true);
      }
      seen.add(frag.fragmentId);
    }
  });

  it('root fragment targets coordinator', () => {
    const scan = LogicalScan('ORDERS', ['ID'], 'ORDERS');
    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(scan);

    const root = plan.getRootFragment();
    expect(root.targetNodes).toContain('coord');
  });

  it('handles filter above scan under exchange', () => {
    const scan = LogicalScan('ORDERS', ['ID', 'STATUS'], 'ORDERS');
    const filter = LogicalFilter(
      { kind: BoundExprKind.BINARY, op: '=', left: colRef('ORDERS', 'STATUS'), right: { kind: BoundExprKind.LITERAL, value: 'active' } },
      scan
    );
    filter._cardinality = 500;
    const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, filter);

    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(exchange);

    expect(plan.fragments.length).toBeGreaterThanOrEqual(3);
  });

  it('handles join of two distributed tables under exchange', () => {
    const left = LogicalScan('ORDERS', ['ID'], 'ORDERS');
    left._cardinality = 10000;
    const right = LogicalScan('LINEITEM', ['ORDER_ID', 'AMOUNT'], 'LINEITEM');
    right._cardinality = 50000;

    const cond = {
      kind: BoundExprKind.BINARY,
      op: '=',
      left: colRef('ORDERS', 'ID'),
      right: colRef('LINEITEM', 'ORDER_ID'),
    };

    const leftExchange = LogicalExchange(ExchangeType.GATHER, [], 0, left);
    const rightExchange = LogicalExchange(ExchangeType.GATHER, [], 0, right);

    const join = LogicalJoin(JoinType.INNER, cond, leftExchange, rightExchange);
    join._cardinality = 50000;

    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(join);

    expect(plan.fragments.length).toBeGreaterThanOrEqual(5);
  });

  it('handles non-partitioned table as single fragment', () => {
    const scan = LogicalScan('LOCAL_TABLE', ['X'], 'LOCAL_TABLE');
    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(scan);

    expect(plan.fragments.length).toBe(1);
    const root = plan.getRootFragment();
    expect(root.isLeaf()).toBe(true);
  });

  it('getReadyFragments returns leaf fragments first', () => {
    const scan = LogicalScan('ORDERS', ['ID'], 'ORDERS');
    scan._cardinality = 1000;
    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(scan);

    const ready = plan.getReadyFragments();
    expect(ready.length).toBeGreaterThan(0);
    for (const f of ready) {
      expect(f.isLeaf()).toBe(true);
    }
  });

  it('allCompleted is false initially', () => {
    const scan = LogicalScan('ORDERS', ['ID'], 'ORDERS');
    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(scan);

    expect(plan.allCompleted()).toBe(false);
  });
});
