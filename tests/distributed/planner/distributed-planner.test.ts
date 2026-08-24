import { describe, it, expect, beforeEach } from 'vitest';
import { DistributedPlanner } from '../../../src/distributed/planner/distributed-planner.js';
import { PartitionMap } from '../../../src/distributed/partition/partition-map.js';
import { HashPartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';
import { ClusterManager } from '../../../src/distributed/cluster/cluster-manager.js';
import { NodeDescriptor, NodeRole } from '../../../src/distributed/cluster/node-descriptor.js';
import { PlanNodeType, LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalAggregate, LogicalExchange, LogicalUnion, LogicalDistinct, JoinType } from '../../../src/planner/logical-plan.js';
import { ExchangeType } from '../../../src/distributed/planner/fragment.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { resetFragmentIdCounter } from '../../../src/distributed/planner/fragment.js';
import { PhysicalPlanner } from '../../../src/execution/physical-planner.js';

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

  describe('partition pruning', () => {
    function lit(value) {
      return { kind: BoundExprKind.LITERAL, value };
    }

    function eq(table, column, value) {
      return { kind: BoundExprKind.BINARY, op: '=', left: colRef(table, column), right: lit(value) };
    }

    function leafWorkersFor(plan) {
      return new Set(plan.getLeafFragments().flatMap(fragment => fragment.targetNodes));
    }

    it('narrows the scan to the partitions a point filter can reach', () => {
      const scan = LogicalScan('ORDERS', ['ID', 'STATUS'], 'ORDERS');
      const filtered = LogicalFilter(eq('ORDERS', 'ID', 7), scan);
      const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, filtered);

      const plan = new DistributedPlanner(pm, cm).fragmentize(exchange);
      expect(leafWorkersFor(plan).size).toBe(1);
    });

    it('keeps every worker when no filter constrains the partition key', () => {
      const scan = LogicalScan('ORDERS', ['ID', 'STATUS'], 'ORDERS');
      const filtered = LogicalFilter(eq('ORDERS', 'STATUS', 'OPEN'), scan);
      const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, filtered);

      const plan = new DistributedPlanner(pm, cm).fragmentize(exchange);
      expect(leafWorkersFor(plan).size).toBe(2);
    });

    it('does not apply a filter that sits above a join to the scans beneath it', () => {
      const orders = LogicalScan('ORDERS', ['ID'], 'ORDERS');
      const lineitem = LogicalScan('LINEITEM', ['ORDER_ID'], 'LINEITEM');
      const join = LogicalJoin(JoinType.INNER, {
        kind: BoundExprKind.BINARY,
        op: '=',
        left: colRef('ORDERS', 'ID'),
        right: colRef('LINEITEM', 'ORDER_ID'),
      }, orders, lineitem);
      const filtered = LogicalFilter(eq('ORDERS', 'ID', 7), join);
      const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, filtered);

      const plan = new DistributedPlanner(pm, cm).fragmentize(exchange);
      expect(leafWorkersFor(plan).size).toBe(2);
    });
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

  describe('worker placement follows the declared input requirement of each operator', () => {
    function workerPlans(root) {
      const types = (node, acc = []) => {
        if (!node) return acc;
        acc.push(node.type);
        for (const child of node.children || []) types(child, acc);
        return acc;
      };
      const plan = new DistributedPlanner(pm, cm).fragmentize(root);
      return plan.fragments
        .filter(f => (f.targetNodes || []).some(n => n !== 'coord'))
        .flatMap(f => types(f.planRoot));
    }
    function partitionedScan() {
      const s = LogicalScan('ORDERS', ['ID'], 'ORDERS');
      s._cardinality = 10000;
      return s;
    }
    function gathered(node) {
      node._cardinality = 10000;
      return LogicalExchange(ExchangeType.GATHER, [], 0, node);
    }

    it('leaves an operator it has no declaration for on the coordinator', () => {
      const undeclared = { type: 'AnOperatorTheRegistryHasNeverSeen', children: [partitionedScan()] };
      const plans = workerPlans(gathered(undeclared));

      expect(plans.length).toBeGreaterThan(0);
      expect(plans).not.toContain(undeclared.type);
      expect(new Set(plans)).toEqual(new Set([PlanNodeType.SCAN]));
    });

    it('keeps a window function off the workers, since it reads every row', () => {
      const window = { type: PlanNodeType.WINDOW, children: [partitionedScan()], windowExprs: [] };
      expect(workerPlans(gathered(window))).not.toContain(PlanNodeType.WINDOW);
    });

    it('keeps a correlated join off the workers', () => {
      const dependent = {
        type: PlanNodeType.DEPENDENT_JOIN,
        children: [partitionedScan(), partitionedScan()],
        correlatedColumns: [],
      };
      expect(workerPlans(gathered(dependent))).not.toContain(PlanNodeType.DEPENDENT_JOIN);
    });

    it('pushes a local pre-pass down when an exchange above it will combine the partials', () => {
      const local = LogicalDistinct(partitionedScan());
      const plan = LogicalDistinct(LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 0, local));

      expect(workerPlans(plan)).toContain(PlanNodeType.DISTINCT);
    });

    it('stops pushing it down once an operator between it and the exchange discards the partitioning', () => {
      const inner = LogicalDistinct(partitionedScan());
      const plan = LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 0, LogicalDistinct(inner));

      expect(workerPlans(plan)).not.toContain(PlanNodeType.DISTINCT);
    });

    it('keeps pushing it down through an operator that preserves the partitioning', () => {
      const inner = LogicalDistinct(partitionedScan());
      const plan = LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 0, LogicalProject([colRef('ORDERS', 'ID')], inner));

      expect(workerPlans(plan)).toContain(PlanNodeType.DISTINCT);
    });

    it('lets an aggregate ride along when a colocated join has already grouped its rows', () => {
      const join = LogicalJoin(
        JoinType.INNER,
        { kind: BoundExprKind.BINARY, op: '=', left: colRef('ORDERS', 'ID'), right: colRef('LINEITEM', 'ORDER_ID') },
        LogicalScan('ORDERS', ['ID'], 'ORDERS'),
        LogicalScan('LINEITEM', ['ORDER_ID'], 'LINEITEM'),
      );
      join._distributionStrategy = 'colocated';
      const aggregate = LogicalAggregate([colRef('ORDERS', 'ID')], [{ func: 'COUNT', args: [] }], join);

      expect(workerPlans(gathered(aggregate))).toContain(PlanNodeType.AGGREGATE);
    });

    it('keeps that same aggregate off the workers without the colocated join', () => {
      const aggregate = LogicalAggregate([colRef('ORDERS', 'ID')], [{ func: 'COUNT', args: [] }], partitionedScan());

      expect(workerPlans(gathered(aggregate))).not.toContain(PlanNodeType.AGGREGATE);
    });
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

  describe('schema carried across an exchange', () => {
    function projectOf(names) {
      return LogicalProject(
        names.map(name => ({ ...colRef('ORDERS', name), outputName: name, dataType: 'INT32' })),
        LogicalScan('ORDERS', names, 'ORDERS'),
      );
    }

    function findReceive(node) {
      if (!node) return null;
      if (node.type === PlanNodeType.EXCHANGE_RECEIVE) return node;
      for (const child of node.children || []) {
        const found = findReceive(child);
        if (found) return found;
      }
      return null;
    }

    function receiveSchemaFor(child) {
      const planner = new DistributedPlanner(pm, cm);
      const plan = planner.fragmentize(LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 0, child));
      return findReceive(plan.getRootFragment().planRoot).schema.map(c => c.name);
    }

    it('takes a set operation output schema from its left input', () => {
      expect(receiveSchemaFor(LogicalUnion(projectOf(['A', 'B']), projectOf(['C', 'D']), false))).toEqual(['A', 'B']);
    });

    it('passes the schema through schema-preserving operators', () => {
      expect(receiveSchemaFor(LogicalDistinct(LogicalFilter(null, projectOf(['A']))))).toEqual(['A']);
    });

    it('reports no schema for a subtree it cannot derive', () => {
      const planner = new DistributedPlanner(pm, cm);
      const join = LogicalJoin(JoinType.INNER, null, projectOf(['A']), projectOf(['B']));
      expect(planner._deriveSubtreeSchema(join)).toEqual([]);
    });

    it('gathers below an aggregate rather than sending the aggregate to the workers', () => {
      expect(receiveSchemaFor(LogicalAggregate([], [], projectOf(['A'])))).toEqual(['A']);
    });
  });

  describe('what an exchange receive reports it will receive', () => {
    const SCHEMAS = {
      ORDERS: [{ name: 'ID', dataType: 'INT32', tableAlias: 'ORDERS' }],
      LINEITEM: [{ name: 'ORDER_ID', dataType: 'INT32', tableAlias: 'LINEITEM' }],
    };

    function catalog() {
      return {
        getTableStorage: (table) => {
          const schema = SCHEMAS[table.toUpperCase()];
          return schema ? { getSchema: () => schema } : null;
        },
      };
    }

    function plannerWithCatalog() {
      return new DistributedPlanner(pm, cm, new Map(), catalog());
    }

    function receivesIn(node, found = []) {
      if (node.type === PlanNodeType.EXCHANGE_RECEIVE) found.push(node);
      for (const child of node.children ?? []) receivesIn(child, found);
      return found;
    }

    function allReceives(plan) {
      return plan.fragments.flatMap(fragment => receivesIn(fragment.planRoot));
    }

    function shuffleJoin(leftCardinality, rightCardinality, joinCardinality) {
      const left = LogicalScan('ORDERS', ['ID'], 'ORDERS');
      left._cardinality = leftCardinality;
      const right = LogicalScan('LINEITEM', ['ORDER_ID'], 'LINEITEM');
      right._cardinality = rightCardinality;
      const join = LogicalJoin(
        JoinType.INNER,
        { kind: BoundExprKind.BINARY, op: '=', left: colRef('ORDERS', 'ID'), right: colRef('LINEITEM', 'ORDER_ID') },
        left,
        right,
      );
      join._cardinality = joinCardinality;
      join._distributionStrategy = 'shuffle';
      return join;
    }

    it('reports the whole subtree when a gather collects every worker', () => {
      const scan = LogicalScan('ORDERS', ['ID'], 'ORDERS');
      scan._cardinality = 90000;

      const plan = new DistributedPlanner(pm, cm).fragmentize(LogicalExchange(ExchangeType.GATHER, [], 0, scan));

      expect(allReceives(plan).map(node => node.sourceCardinality)).toEqual([90000]);
    });

    it('reports one worker share on each side of a hash shuffle', () => {
      const plan = plannerWithCatalog().fragmentize(shuffleJoin(100000, 400000, 400000));
      const workers = cm.getWorkerNodes().length;
      const joinFragment = plan.fragments.find(fragment => fragment.planRoot.type === PlanNodeType.JOIN);

      const shares = receivesIn(joinFragment.planRoot).map(node => node.sourceCardinality);

      expect(shares).toEqual([100000 / workers, 400000 / workers]);
    });

    it('reports the gathered join result whole, not per worker', () => {
      const plan = plannerWithCatalog().fragmentize(shuffleJoin(100000, 400000, 400000));
      const root = plan.getRootFragment();

      expect(receivesIn(root.planRoot).map(node => node.sourceCardinality)).toEqual([400000]);
    });

    it('rounds a worker share up so a shuffled row is never lost to the estimate', () => {
      const plan = plannerWithCatalog().fragmentize(shuffleJoin(5, 5, 5));

      for (const receive of allReceives(plan)) {
        expect(receive.sourceCardinality).toBeGreaterThan(0);
      }
    });

    it('leaves the row count unstated when the subtree carries no estimate', () => {
      const scan = LogicalScan('ORDERS', ['ID'], 'ORDERS');

      const plan = new DistributedPlanner(pm, cm).fragmentize(LogicalExchange(ExchangeType.GATHER, [], 0, scan));

      for (const receive of allReceives(plan)) {
        expect(receive.sourceCardinality).toBeUndefined();
      }
    });

    it('costs a shuffle join fragment by the rows it actually receives', () => {
      const plan = plannerWithCatalog().fragmentize(shuffleJoin(100000, 400000, 400000));
      const joinFragment = plan.fragments.find(fragment => fragment.planRoot.type === PlanNodeType.JOIN);
      const physical = new PhysicalPlanner().plan(joinFragment.planRoot);

      expect(physical.children.map(child => child.cardinality))
        .toEqual([100000 / cm.getWorkerNodes().length, 400000 / cm.getWorkerNodes().length]);
    });
  });

  it('gives every fragment a distinct id across separate plans', () => {
    const planner = new DistributedPlanner(pm, cm);
    const first = planner.fragmentize(LogicalScan('ORDERS', ['ID'], 'ORDERS'));
    const second = planner.fragmentize(LogicalScan('ORDERS', ['ID'], 'ORDERS'));

    const ids = [...first.fragments, ...second.fragments].map(f => f.fragmentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('allCompleted is false initially', () => {
    const scan = LogicalScan('ORDERS', ['ID'], 'ORDERS');
    const planner = new DistributedPlanner(pm, cm);
    const plan = planner.fragmentize(scan);

    expect(plan.allCompleted()).toBe(false);
  });
  describe('joins against a replicated table', () => {
    function colocatedJoin(joinType = JoinType.INNER) {
      pm.registerReplicatedTable('DIM');
      const join = LogicalJoin(
        joinType,
        { kind: BoundExprKind.BINARY, op: '=', left: colRef('ORDERS', 'CAT'), right: colRef('DIM', 'DCAT') },
        LogicalScan('ORDERS', [], 'ORDERS'),
        LogicalScan('DIM', [], 'DIM'),
      );
      join._distributionStrategy = 'colocated';
      return join;
    }

    function fragmentShapes(plan) {
      const root = plan.getRootFragment();
      return plan.fragments.filter((f) => f !== root).map((f) => f.planRoot.type);
    }

    it('runs the join on the workers instead of gathering the partitioned side', () => {
      const planner = new DistributedPlanner(pm, cm, new Map(), null);

      const plan = planner.fragmentize(colocatedJoin());

      expect(fragmentShapes(plan)).toEqual([PlanNodeType.JOIN, PlanNodeType.JOIN]);
    });

    it('keeps an aggregate above the join on the workers', () => {
      const planner = new DistributedPlanner(pm, cm, new Map(), null);
      const join = colocatedJoin();
      const aggregate = LogicalAggregate([], [], join);
      const exchange = LogicalExchange(ExchangeType.GATHER, null, null, aggregate);

      const plan = planner.fragmentize(exchange);

      expect(fragmentShapes(plan)).toEqual([PlanNodeType.AGGREGATE, PlanNodeType.AGGREGATE]);
    });

    it('does not push a join whose replicated side is not declared replicated', () => {
      const planner = new DistributedPlanner(pm, cm, new Map(), null);
      const join = LogicalJoin(
        JoinType.INNER,
        { kind: BoundExprKind.BINARY, op: '=', left: colRef('ORDERS', 'CAT'), right: colRef('UNKNOWN', 'DCAT') },
        LogicalScan('ORDERS', [], 'ORDERS'),
        LogicalScan('UNKNOWN', [], 'UNKNOWN'),
      );
      join._distributionStrategy = 'colocated';

      const plan = planner.fragmentize(join);

      expect(fragmentShapes(plan)).not.toEqual([PlanNodeType.JOIN, PlanNodeType.JOIN]);
    });
  });
});
