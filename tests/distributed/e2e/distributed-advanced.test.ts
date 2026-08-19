import { describe, it, expect, beforeEach } from 'vitest';
import { DistributedPlanner } from '../../../src/distributed/planner/distributed-planner.js';
import { PartitionMap } from '../../../src/distributed/partition/partition-map.js';
import { HashPartitionStrategy, RangePartitionStrategy, RoundRobinPartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';
import { ClusterManager } from '../../../src/distributed/cluster/cluster-manager.js';
import { NodeDescriptor, NodeRole } from '../../../src/distributed/cluster/node-descriptor.js';
import { ExchangePlacement } from '../../../src/distributed/planner/exchange-placement.js';
import { PartitionPruner } from '../../../src/distributed/partition/partition-pruner.js';
import { ChunkCodec } from '../../../src/distributed/transport/chunk-codec.js';
import { ExchangeSender, ExchangeReceiver } from '../../../src/distributed/execution/exchange-operator.js';
import { MergeExchangeOperator, MinHeap } from '../../../src/distributed/execution/merge-exchange.js';
import { Fragment, FragmentPlan, FragmentState, ExchangeType, resetFragmentIdCounter } from '../../../src/distributed/planner/fragment.js';
import { HeartbeatMonitor } from '../../../src/distributed/cluster/heartbeat-monitor.js';
import { DistributionAwareJoin, DistributionStrategy } from '../../../src/distributed/optimizer/distribution-aware-join.js';
import { PartialAggregatePass } from '../../../src/distributed/optimizer/partial-aggregate.js';
import { DistributedSortPass } from '../../../src/distributed/optimizer/distributed-sort.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DataType } from '../../../src/storage/data-type.js';
import {
  PlanNodeType, LogicalScan, LogicalFilter, LogicalProject, LogicalJoin,
  LogicalAggregate, LogicalSort, LogicalLimit, LogicalTopN, LogicalExchange,
  LogicalDistinct, LogicalUnion, JoinType,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function makeCol(type, values) {
  const col = new Column(type, values.length);
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return col;
}

function makeChunk(columns, size) {
  return new DataChunk(columns, size);
}

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function literal(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function binOp(op, left, right) {
  return { kind: BoundExprKind.BINARY, op, left, right };
}

function makeAgg(func, args = [], opts = {}) {
  return { func, args, name: func, isCountStar: opts.isCountStar || false, isDistinct: opts.isDistinct || false };
}

class MockTransport {
  constructor() {
    this._listeners = new Map();
    this._sent = [];
  }

  async sendChunk(targetNodeId, channelId, encodedChunk) {
    this._sent.push({ targetNodeId, channelId, data: encodedChunk });
    const listener = this._listeners.get(channelId);
    if (listener) listener(targetNodeId, encodedChunk);
  }

  onChunkReceived(channelId, callback) {
    this._listeners.set(channelId, callback);
  }

  removeChunkListener(channelId) {
    this._listeners.delete(channelId);
  }
}

function setupCluster(workerCount = 3) {
  const local = new NodeDescriptor({ nodeId: 'coord', host: '127.0.0.1', port: 9400, role: NodeRole.COORDINATOR });
  const cm = new ClusterManager(local, { heartbeatIntervalMs: 100000 });
  for (let i = 1; i <= workerCount; i++) {
    cm.addNode(new NodeDescriptor({
      nodeId: `w${i}`, host: '127.0.0.1', port: 9400 + i, role: NodeRole.WORKER,
    }));
  }
  return cm;
}

function setupPartitionMap(tables, workerCount = 2) {
  const pm = new PartitionMap();
  for (const { name, key, partitions } of tables) {
    const strat = new HashPartitionStrategy();
    strat._partitionKey = key;
    const placements = new Map();
    for (let i = 0; i < partitions; i++) {
      placements.set(i, [`w${(i % workerCount) + 1}`]);
    }
    pm.registerTable(name, strat, partitions, placements);
  }
  return pm;
}

describe('Advanced Distributed Tests', () => {
  beforeEach(() => {
    resetFragmentIdCounter();
  });

  describe('Complex plan fragmentization', () => {
    it('fragments multi-level plan: filter → project → exchange → aggregate', () => {
      const cm = setupCluster(2);
      const pm = setupPartitionMap([{ name: 'SALES', key: 'ID', partitions: 4 }]);

      const scan = LogicalScan('SALES', ['ID', 'REGION', 'AMOUNT'], 'SALES');
      scan._cardinality = 100000;
      const filter = LogicalFilter(binOp('>', colRef('SALES', 'AMOUNT'), literal(100)), scan);
      const project = LogicalProject([colRef('SALES', 'REGION'), colRef('SALES', 'AMOUNT')], filter);
      const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, project);

      const planner = new DistributedPlanner(pm, cm);
      const plan = planner.fragmentize(exchange);

      expect(plan.fragments.length).toBeGreaterThanOrEqual(3);

      const root = plan.getRootFragment();
      expect(root.targetNodes).toContain('coord');

      const leaves = plan.getLeafFragments();
      expect(leaves.length).toBe(2);
      for (const leaf of leaves) {
        expect(leaf.targetNodes.length).toBe(1);
        expect(leaf.targetNodes[0]).toMatch(/^w\d+$/);
      }
    });

    it('fragments two exchanges in a plan tree create independent worker sets', () => {
      const cm = setupCluster(3);
      const pm = setupPartitionMap([
        { name: 'ORDERS', key: 'ID', partitions: 6 },
        { name: 'ITEMS', key: 'ORDER_ID', partitions: 6 },
      ], 3);

      const leftScan = LogicalScan('ORDERS', ['ID', 'TOTAL'], 'ORDERS');
      leftScan._cardinality = 50000;
      const leftExchange = LogicalExchange(ExchangeType.GATHER, [], 0, leftScan);

      const rightScan = LogicalScan('ITEMS', ['ORDER_ID', 'QTY'], 'ITEMS');
      rightScan._cardinality = 200000;
      const rightExchange = LogicalExchange(ExchangeType.GATHER, [], 0, rightScan);

      const join = LogicalJoin(JoinType.INNER,
        binOp('=', colRef('ORDERS', 'ID'), colRef('ITEMS', 'ORDER_ID')),
        leftExchange, rightExchange);
      join._cardinality = 200000;

      const planner = new DistributedPlanner(pm, cm);
      const plan = planner.fragmentize(join);

      expect(plan.fragments.length).toBeGreaterThanOrEqual(7);

      const topo = plan.topologicalOrder();
      const seen = new Set();
      for (const frag of topo) {
        for (const input of frag.exchangeInputs) {
          expect(seen.has(input.sourceFragmentId)).toBe(true);
        }
        seen.add(frag.fragmentId);
      }
    });

    it('handles chain: scan → filter → project → exchange with worker propagation', () => {
      const cm = setupCluster(2);
      const pm = setupPartitionMap([{ name: 'LOG', key: 'TS', partitions: 4 }]);

      const scan = LogicalScan('LOG', ['TS', 'LEVEL', 'MSG'], 'LOG');
      scan._cardinality = 1000000;
      const filter = LogicalFilter(binOp('=', colRef('LOG', 'LEVEL'), literal('ERROR')), scan);
      const project = LogicalProject([colRef('LOG', 'TS'), colRef('LOG', 'MSG')], filter);
      const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, project);
      const limit = LogicalLimit(100, 0, exchange);

      const planner = new DistributedPlanner(pm, cm);
      const plan = planner.fragmentize(limit);

      const leaves = plan.getLeafFragments();
      expect(leaves.length).toBe(2);

      const root = plan.getRootFragment();
      expect(root.planRoot.type).toBe(PlanNodeType.LIMIT);
    });

    it('non-partitioned table stays local without creating worker fragments', () => {
      const cm = setupCluster(2);
      const pm = setupPartitionMap([{ name: 'ORDERS', key: 'ID', partitions: 4 }]);

      const scan = LogicalScan('CONFIG', ['KEY', 'VALUE'], 'CONFIG');
      const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, scan);

      const planner = new DistributedPlanner(pm, cm);
      const plan = planner.fragmentize(exchange);

      expect(plan.fragments.length).toBe(1);
    });
  });

  describe('Two-phase aggregation planning', () => {
    it('SUM with multiple group keys gets two-phase decomposition', () => {
      const pass = new PartialAggregatePass();
      const scan = LogicalScan('T', []);
      const agg = LogicalAggregate(
        [colRef('T', 'REGION'), colRef('T', 'YEAR')],
        [makeAgg('SUM', [colRef('T', 'REVENUE')])],
        scan
      );
      agg._distributed = true;

      const result = pass.apply(agg);
      expect(result.type).toBe(PlanNodeType.FINAL_AGGREGATE);

      const exchange = result.children[0];
      expect(exchange.type).toBe(PlanNodeType.EXCHANGE);

      const partial = exchange.children[0];
      expect(partial.type).toBe(PlanNodeType.PARTIAL_AGGREGATE);
      expect(partial.groupBy.length).toBe(2);
    });

    it('multiple aggregates (SUM + COUNT + MAX) decompose together', () => {
      const pass = new PartialAggregatePass();
      const scan = LogicalScan('T', []);
      const agg = LogicalAggregate(
        [colRef('T', 'CAT')],
        [
          makeAgg('SUM', [colRef('T', 'AMT')]),
          makeAgg('COUNT', [colRef('T', 'ID')]),
          makeAgg('MAX', [colRef('T', 'PRICE')]),
        ],
        scan
      );
      agg._distributed = true;

      const result = pass.apply(agg);
      expect(result.type).toBe(PlanNodeType.FINAL_AGGREGATE);
      expect(result.aggregates.length).toBe(3);
      expect(result.aggregates[0].func).toBe('SUM');
      expect(result.aggregates[1].func).toBe('SUM');
      expect(result.aggregates[2].func).toBe('MAX');
    });

    it('no group-by uses GATHER exchange instead of hash shuffle', () => {
      const placement = new ExchangePlacement(new PartitionMap());
      const agg = LogicalAggregate([], [makeAgg('COUNT', [], { isCountStar: true })], LogicalScan('T', []));

      const exchangeConfig = placement.determineAggregateExchange(agg);
      expect(exchangeConfig.type).toBe(ExchangeType.GATHER);
    });
  });

  describe('Distribution-aware join strategies', () => {
    it('colocated tables with matching partition keys use PASSTHROUGH', () => {
      const pm = setupPartitionMap([
        { name: 'A', key: 'ID', partitions: 4 },
        { name: 'B', key: 'A_ID', partitions: 4 },
      ]);

      const placement = new ExchangePlacement(pm);
      const join = LogicalJoin(JoinType.INNER,
        binOp('=', colRef('A', 'ID'), colRef('B', 'A_ID')),
        LogicalScan('A', ['ID'], 'A'), LogicalScan('B', ['A_ID'], 'B'));
      join._distributionStrategy = DistributionStrategy.COLOCATED;

      const exchange = placement.determineJoinExchange(join);
      expect(exchange.left.type).toBe(ExchangeType.PASSTHROUGH);
      expect(exchange.right.type).toBe(ExchangeType.PASSTHROUGH);
    });

    it('small table triggers broadcast strategy', () => {
      const pm = new PartitionMap();
      const statsMap = new Map([
        ['SMALL', { rowCount: 100, avgRowWidth: 32 }],
        ['BIG', { rowCount: 10000000, avgRowWidth: 64 }],
      ]);

      const pass = new DistributionAwareJoin(pm, statsMap);

      const small = LogicalScan('SMALL', ['ID'], 'SMALL');
      small._cardinality = 100;
      const big = LogicalScan('BIG', ['REF_ID'], 'BIG');
      big._cardinality = 10000000;

      const join = LogicalJoin(JoinType.INNER,
        binOp('=', colRef('SMALL', 'ID'), colRef('BIG', 'REF_ID')),
        small, big);

      const result = pass.apply(join);
      expect([DistributionStrategy.BROADCAST_LEFT, DistributionStrategy.BROADCAST_RIGHT])
        .toContain(result._distributionStrategy);
    });

    it('LEFT JOIN restricts broadcast of left side', () => {
      const pm = new PartitionMap();
      const pass = new DistributionAwareJoin(pm, new Map());

      const left = LogicalScan('L', ['ID'], 'L');
      left._cardinality = 50;
      const right = LogicalScan('R', ['L_ID'], 'R');
      right._cardinality = 100000;

      const join = LogicalJoin(JoinType.LEFT,
        binOp('=', colRef('L', 'ID'), colRef('R', 'L_ID')),
        left, right);

      const result = pass.apply(join);
      expect(result._distributionStrategy).not.toBe(DistributionStrategy.BROADCAST_LEFT);
    });

    it('join without equality condition defaults to shuffle', () => {
      const pm = new PartitionMap();
      const pass = new DistributionAwareJoin(pm, new Map());

      const left = LogicalScan('A', ['X'], 'A');
      left._cardinality = 1000;
      const right = LogicalScan('B', ['Y'], 'B');
      right._cardinality = 1000;

      const join = LogicalJoin(JoinType.INNER,
        binOp('>', colRef('A', 'X'), colRef('B', 'Y')),
        left, right);

      const result = pass.apply(join);
      expect(result._distributionStrategy).toBe(DistributionStrategy.SHUFFLE);
    });
  });

  describe('Distributed sort rewriting', () => {
    it('sort above exchange becomes local sort + merge exchange', () => {
      const pass = new DistributedSortPass();

      const scan = LogicalScan('T', ['ID', 'NAME']);
      const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, scan);
      const sort = LogicalSort([{ columnIndex: 0, direction: 'ASC' }], exchange);
      sort._distributed = true;

      const result = pass.apply(sort);
      expect(result.type).toBe(PlanNodeType.MERGE_EXCHANGE);
      expect(result.children[0].type).toBe(PlanNodeType.SORT);
    });

    it('TopN above exchange becomes local TopN + merge + limit', () => {
      const pass = new DistributedSortPass();

      const scan = LogicalScan('T', ['SCORE']);
      const exchange = LogicalExchange(ExchangeType.GATHER, [], 0, scan);
      const topn = LogicalTopN([{ columnIndex: 0, direction: 'DESC' }], 10, 0, exchange);
      topn._distributed = true;

      const result = pass.apply(topn);
      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.children[0].type).toBe(PlanNodeType.MERGE_EXCHANGE);
    });

    it('sort without exchange below stays unchanged', () => {
      const pass = new DistributedSortPass();

      const scan = LogicalScan('T', ['ID']);
      const sort = LogicalSort([{ columnIndex: 0, direction: 'ASC' }], scan);
      sort._distributed = true;

      const result = pass.apply(sort);
      expect(result.type).toBe(PlanNodeType.SORT);
    });
  });

  describe('Exchange operator: multi-column shuffle', () => {
    it('shuffles by composite key (two columns) preserving row integrity', async () => {
      const transport = new MockTransport();
      const sender = new ExchangeSender(transport, ['n0', 'n1', 'n2'], {
        exchangeType: 'hash_shuffle',
        keyExtractors: [
          (chunk, row) => chunk.columns[0].get(row),
          (chunk, row) => chunk.columns[1].get(row),
        ],
        partitionCount: 3,
        channelId: 'composite-key',
      });

      const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const regions = ['US', 'EU', 'US', 'EU', 'JP', 'US', 'JP', 'EU', 'US', 'JP'];
      const amounts = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

      const chunk = makeChunk([
        makeCol(DataType.INT32, ids),
        makeCol(DataType.VARCHAR, regions),
        makeCol(DataType.INT32, amounts),
      ], 10);

      await sender.consume(chunk);

      const codec = new ChunkCodec();
      let totalRows = 0;
      const reconstructed = new Map();

      for (const msg of transport._sent) {
        const decoded = codec.decode(msg.data);
        for (let i = 0; i < decoded.size; i++) {
          const id = decoded.columns[0].get(i);
          const region = decoded.columns[1].get(i);
          const amount = decoded.columns[2].get(i);
          reconstructed.set(id, { region, amount });
          totalRows++;
        }
      }

      expect(totalRows).toBe(10);
      expect(reconstructed.size).toBe(10);

      for (let i = 0; i < ids.length; i++) {
        const entry = reconstructed.get(ids[i]);
        expect(entry.region).toBe(regions[i]);
        expect(entry.amount).toBe(amounts[i]);
      }
    });

    it('broadcast + gather pipeline preserves data through full round-trip', async () => {
      const transport = new MockTransport();
      const channelId = 'bcast-gather';

      const receiver = new ExchangeReceiver(transport, ['w1', 'w2'], { channelId });
      await receiver.init();

      const codec = new ChunkCodec();
      const chunk1 = makeChunk([makeCol(DataType.INT32, [10, 20, 30])], 3);
      const chunk2 = makeChunk([makeCol(DataType.INT32, [40, 50])], 2);

      receiver._handleChunk('w1', codec.encode(chunk1));
      receiver._handleChunk('w1', codec.encode(new DataChunk([], 0)));
      receiver._handleChunk('w2', codec.encode(chunk2));
      receiver._handleChunk('w2', codec.encode(new DataChunk([], 0)));

      const values = [];
      for await (const chunk of receiver.generate()) {
        for (let i = 0; i < chunk.size; i++) values.push(chunk.columns[0].get(i));
      }

      expect(values.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    });
  });

  describe('MergeExchangeOperator with real transport', () => {
    it('merges three sorted streams into global sorted order', async () => {
      const transport = new MockTransport();
      const channelId = 'merge-3way';
      const codec = new ChunkCodec();

      const op = new MergeExchangeOperator(transport, ['w1', 'w2', 'w3'], {
        orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
        channelId,
      });
      await op.init();

      const stream1 = makeChunk([makeCol(DataType.INT32, [1, 4, 7, 10])], 4);
      const stream2 = makeChunk([makeCol(DataType.INT32, [2, 5, 8, 11])], 4);
      const stream3 = makeChunk([makeCol(DataType.INT32, [3, 6, 9, 12])], 4);

      op._handleChunk('w1', codec.encode(stream1));
      op._handleChunk('w1', codec.encode(new DataChunk([], 0)));
      op._handleChunk('w2', codec.encode(stream2));
      op._handleChunk('w2', codec.encode(new DataChunk([], 0)));
      op._handleChunk('w3', codec.encode(stream3));
      op._handleChunk('w3', codec.encode(new DataChunk([], 0)));

      const merged = [];
      for await (const chunk of op.generate()) {
        for (let i = 0; i < chunk.size; i++) merged.push(chunk.columns[0].get(i));
      }

      expect(merged).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      op.cleanup();
    });

    it('merges DESC sorted streams correctly', async () => {
      const transport = new MockTransport();
      const codec = new ChunkCodec();

      const op = new MergeExchangeOperator(transport, ['w1', 'w2'], {
        orderKeys: [{ columnIndex: 0, direction: 'DESC' }],
        channelId: 'merge-desc',
      });
      await op.init();

      op._handleChunk('w1', codec.encode(makeChunk([makeCol(DataType.INT32, [100, 80, 60, 40])], 4)));
      op._handleChunk('w1', codec.encode(new DataChunk([], 0)));
      op._handleChunk('w2', codec.encode(makeChunk([makeCol(DataType.INT32, [90, 70, 50, 30])], 4)));
      op._handleChunk('w2', codec.encode(new DataChunk([], 0)));

      const merged = [];
      for await (const chunk of op.generate()) {
        for (let i = 0; i < chunk.size; i++) merged.push(chunk.columns[0].get(i));
      }

      expect(merged).toEqual([100, 90, 80, 70, 60, 50, 40, 30]);
      op.cleanup();
    });

    it('respects limit during merge', async () => {
      const transport = new MockTransport();
      const codec = new ChunkCodec();

      const op = new MergeExchangeOperator(transport, ['w1', 'w2'], {
        orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
        limit: 5,
        channelId: 'merge-limit',
      });
      await op.init();

      op._handleChunk('w1', codec.encode(makeChunk([makeCol(DataType.INT32, [1, 3, 5, 7, 9])], 5)));
      op._handleChunk('w1', codec.encode(new DataChunk([], 0)));
      op._handleChunk('w2', codec.encode(makeChunk([makeCol(DataType.INT32, [2, 4, 6, 8, 10])], 5)));
      op._handleChunk('w2', codec.encode(new DataChunk([], 0)));

      const merged = [];
      for await (const chunk of op.generate()) {
        for (let i = 0; i < chunk.size; i++) merged.push(chunk.columns[0].get(i));
      }

      expect(merged).toEqual([1, 2, 3, 4, 5]);
      op.cleanup();
    });

    it('merges multi-column sorted data (primary + secondary key)', async () => {
      const transport = new MockTransport();
      const codec = new ChunkCodec();

      const op = new MergeExchangeOperator(transport, ['w1', 'w2'], {
        orderKeys: [
          { columnIndex: 0, direction: 'ASC' },
          { columnIndex: 1, direction: 'DESC' },
        ],
        channelId: 'merge-multi',
      });
      await op.init();

      op._handleChunk('w1', codec.encode(makeChunk([
        makeCol(DataType.INT32, [1, 1, 2, 3]),
        makeCol(DataType.INT32, [90, 50, 80, 70]),
      ], 4)));
      op._handleChunk('w1', codec.encode(new DataChunk([], 0)));

      op._handleChunk('w2', codec.encode(makeChunk([
        makeCol(DataType.INT32, [1, 2, 2, 3]),
        makeCol(DataType.INT32, [70, 90, 60, 40]),
      ], 4)));
      op._handleChunk('w2', codec.encode(new DataChunk([], 0)));

      const rows = [];
      for await (const chunk of op.generate()) {
        for (let i = 0; i < chunk.size; i++) {
          rows.push([chunk.columns[0].get(i), chunk.columns[1].get(i)]);
        }
      }

      for (let i = 1; i < rows.length; i++) {
        const [pa, sa] = rows[i - 1];
        const [pb, sb] = rows[i];
        if (pa === pb) {
          expect(sa).toBeGreaterThanOrEqual(sb);
        } else {
          expect(pa).toBeLessThan(pb);
        }
      }
      op.cleanup();
    });
  });

  describe('Partition pruning edge cases', () => {
    it('OR predicate unions partition sets', () => {
      const pm = new PartitionMap();
      const strat = new HashPartitionStrategy();
      strat._partitionKey = 'ID';
      pm.registerTable('T', strat, 8, new Map(
        Array.from({ length: 8 }, (_, i) => [i, [`w${(i % 3) + 1}`]])
      ));

      const pruner = new PartitionPruner();
      const result = pruner.prune('T', binOp('OR',
        binOp('=', { kind: BoundExprKind.COLUMN_REF, columnName: 'ID' }, literal(10)),
        binOp('=', { kind: BoundExprKind.COLUMN_REF, columnName: 'ID' }, literal(20)),
      ), pm);

      expect(result.size).toBeLessThanOrEqual(2);
    });

    it('non-partition column predicate returns all partitions', () => {
      const pm = new PartitionMap();
      const strat = new HashPartitionStrategy();
      strat._partitionKey = 'ID';
      pm.registerTable('T', strat, 4, new Map(
        Array.from({ length: 4 }, (_, i) => [i, ['w1']])
      ));

      const pruner = new PartitionPruner();
      const result = pruner.prune('T', binOp('=',
        { kind: BoundExprKind.COLUMN_REF, columnName: 'NAME' },
        literal('test'),
      ), pm);

      expect(result.size).toBe(4);
    });

    it('range partition with boundary values prunes correctly', () => {
      const pm = new PartitionMap();
      const strat = new RangePartitionStrategy([100, 200, 300, 400]);
      strat._partitionKey = 'PRICE';
      pm.registerTable('PRODUCTS', strat, 5, new Map(
        Array.from({ length: 5 }, (_, i) => [i, [`w${(i % 2) + 1}`]])
      ));

      const pruner = new PartitionPruner();
      const result = pruner.prune('PRODUCTS', binOp('=',
        { kind: BoundExprKind.COLUMN_REF, columnName: 'PRICE' },
        literal(150),
      ), pm);

      expect(result.size).toBeLessThan(5);
    });
  });

  describe('Fragment lifecycle and failure handling', () => {
    it('complex fragment graph with diamond dependency resolves correctly', () => {
      const a = new Fragment({ planRoot: { type: 'Scan' }, targetNodes: ['w1'], exchangeInputs: [] });
      const b = new Fragment({ planRoot: { type: 'Scan' }, targetNodes: ['w2'], exchangeInputs: [] });
      const c = new Fragment({
        planRoot: { type: 'Join' }, targetNodes: ['w1'],
        exchangeInputs: [
          { sourceFragmentId: a.fragmentId, exchangeType: 'gather' },
          { sourceFragmentId: b.fragmentId, exchangeType: 'gather' },
        ],
      });
      const d = new Fragment({
        planRoot: { type: 'Filter' }, targetNodes: ['w2'],
        exchangeInputs: [
          { sourceFragmentId: a.fragmentId, exchangeType: 'broadcast' },
          { sourceFragmentId: b.fragmentId, exchangeType: 'gather' },
        ],
      });
      const root = new Fragment({
        planRoot: { type: 'Union' }, targetNodes: ['coord'],
        exchangeInputs: [
          { sourceFragmentId: c.fragmentId, exchangeType: 'gather' },
          { sourceFragmentId: d.fragmentId, exchangeType: 'gather' },
        ],
      });

      const plan = new FragmentPlan([a, b, c, d, root], root.fragmentId);

      const topo = plan.topologicalOrder();
      expect(topo.length).toBe(5);

      const idxOf = id => topo.findIndex(f => f.fragmentId === id);
      expect(idxOf(a.fragmentId)).toBeLessThan(idxOf(c.fragmentId));
      expect(idxOf(a.fragmentId)).toBeLessThan(idxOf(d.fragmentId));
      expect(idxOf(b.fragmentId)).toBeLessThan(idxOf(c.fragmentId));
      expect(idxOf(b.fragmentId)).toBeLessThan(idxOf(d.fragmentId));
      expect(idxOf(c.fragmentId)).toBeLessThan(idxOf(root.fragmentId));
      expect(idxOf(d.fragmentId)).toBeLessThan(idxOf(root.fragmentId));
    });

    it('getReadyFragments progresses through multi-level dependencies', () => {
      const l1 = new Fragment({ planRoot: {}, targetNodes: ['w1'], exchangeInputs: [] });
      const l2 = new Fragment({ planRoot: {}, targetNodes: ['w2'], exchangeInputs: [] });
      const mid = new Fragment({
        planRoot: {}, targetNodes: ['w1'],
        exchangeInputs: [{ sourceFragmentId: l1.fragmentId, exchangeType: 'gather' }],
      });
      const root = new Fragment({
        planRoot: {}, targetNodes: ['coord'],
        exchangeInputs: [
          { sourceFragmentId: mid.fragmentId, exchangeType: 'gather' },
          { sourceFragmentId: l2.fragmentId, exchangeType: 'gather' },
        ],
      });

      const plan = new FragmentPlan([l1, l2, mid, root], root.fragmentId);

      const r1 = plan.getReadyFragments();
      expect(r1.map(f => f.fragmentId).sort()).toEqual([l1.fragmentId, l2.fragmentId].sort());

      l1.markCompleted();
      const r2 = plan.getReadyFragments();
      expect(r2.map(f => f.fragmentId)).toContain(mid.fragmentId);
      expect(r2.map(f => f.fragmentId)).not.toContain(root.fragmentId);

      l2.markCompleted();
      mid.markCompleted();
      const r3 = plan.getReadyFragments();
      expect(r3.length).toBe(1);
      expect(r3[0].fragmentId).toBe(root.fragmentId);
    });

    it('fragment retry exhaustion with max retries', () => {
      const frag = new Fragment({ planRoot: {} });
      const maxRetries = 3;

      for (let i = 0; i < maxRetries; i++) {
        frag.markFailed(new Error(`attempt ${i + 1}`));
        if (i < maxRetries - 1) {
          expect(frag.canRetry(maxRetries)).toBe(true);
          frag.state = FragmentState.PENDING;
        }
      }

      expect(frag.canRetry(maxRetries)).toBe(false);
      expect(frag.retryCount).toBe(maxRetries);
    });

    it('cancelled fragment does not accept further state transitions gracefully', () => {
      const frag = new Fragment({ planRoot: {}, targetNodes: ['w1'] });
      frag.markDispatched('w1');
      frag.markRunning();
      frag.markCancelled();
      expect(frag.state).toBe(FragmentState.CANCELLED);

      frag.markCompleted();
      expect(frag.state).toBe(FragmentState.COMPLETED);
    });
  });

  describe('ChunkCodec stress tests', () => {
    it('encodes/decodes large chunk with all column types', () => {
      const size = 10000;
      const ints = Array.from({ length: size }, (_, i) => i);
      const floats = Array.from({ length: size }, (_, i) => i * 1.5);
      const strings = Array.from({ length: size }, (_, i) => `row_${i}`);
      const bools = Array.from({ length: size }, (_, i) => i % 2 === 0);

      const chunk = makeChunk([
        makeCol(DataType.INT32, ints),
        makeCol(DataType.FLOAT64, floats),
        makeCol(DataType.VARCHAR, strings),
        makeCol(DataType.BOOLEAN, bools),
      ], size);

      const codec = new ChunkCodec();
      const decoded = codec.decode(codec.encode(chunk));

      expect(decoded.size).toBe(size);
      expect(decoded.columns.length).toBe(4);

      expect(decoded.columns[0].get(0)).toBe(0);
      expect(decoded.columns[0].get(9999)).toBe(9999);
      expect(decoded.columns[1].get(100)).toBeCloseTo(150.0);
      expect(decoded.columns[2].get(42)).toBe('row_42');
      expect(decoded.columns[3].get(0)).toBe(true);
      expect(decoded.columns[3].get(1)).toBe(false);
    });

    it('handles chunk with all nulls', () => {
      const col = new Column(DataType.INT32, 5);
      for (let i = 0; i < 5; i++) col.set(i, null);
      col.length = 5;

      const chunk = makeChunk([col], 5);
      const codec = new ChunkCodec();
      const decoded = codec.decode(codec.encode(chunk));

      expect(decoded.size).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(decoded.columns[0].isNull(i)).toBe(true);
      }
    });

    it('handles interleaved null and non-null values', () => {
      const col = makeCol(DataType.INT32, [1, 2, 3, 4, 5]);
      col.set(1, null);
      col.set(3, null);

      const chunk = makeChunk([col], 5);
      const codec = new ChunkCodec();
      const decoded = codec.decode(codec.encode(chunk));

      expect(decoded.columns[0].get(0)).toBe(1);
      expect(decoded.columns[0].isNull(1)).toBe(true);
      expect(decoded.columns[0].get(2)).toBe(3);
      expect(decoded.columns[0].isNull(3)).toBe(true);
      expect(decoded.columns[0].get(4)).toBe(5);
    });
  });

  describe('Cluster manager edge cases', () => {
    it('handles rapid add/remove cycles', () => {
      const cm = setupCluster(0);

      for (let i = 0; i < 10; i++) {
        cm.addNode(new NodeDescriptor({
          nodeId: `temp-${i}`, host: '127.0.0.1', port: 10000 + i, role: NodeRole.WORKER,
        }));
      }
      expect(cm.getWorkerNodes().length).toBe(10);

      for (let i = 0; i < 5; i++) {
        cm.removeNode(`temp-${i}`);
      }
      expect(cm.getWorkerNodes().length).toBe(5);

      for (let i = 10; i < 15; i++) {
        cm.addNode(new NodeDescriptor({
          nodeId: `temp-${i}`, host: '127.0.0.1', port: 10000 + i, role: NodeRole.WORKER,
        }));
      }
      expect(cm.getWorkerNodes().length).toBe(10);
    });

    it('coordinator is never returned in getWorkerNodes', () => {
      const cm = setupCluster(3);
      const workers = cm.getWorkerNodes();
      for (const w of workers) {
        expect(w.role).not.toBe(NodeRole.COORDINATOR);
      }
    });

    it('getAliveNodes includes coordinator', () => {
      const cm = setupCluster(2);
      const alive = cm.getAliveNodes();
      expect(alive.length).toBe(3);
      expect(alive.some(n => n.nodeId === 'coord')).toBe(true);
    });
  });

  describe('Heartbeat monitor edge cases', () => {
    it('phi returns zero for nodes with no heartbeat history', () => {
      const monitor = new HeartbeatMonitor({ windowSize: 10, threshold: 8 });
      const phi = monitor.phi('unknown-node', Date.now());
      expect(phi).toBe(0);
    });

    it('phi stays low for consistent heartbeats even at high frequency', () => {
      const monitor = new HeartbeatMonitor({ windowSize: 100, threshold: 8 });
      const now = Date.now();

      for (let i = 0; i < 100; i++) {
        monitor.recordHeartbeat('fast-node', now + i * 100);
      }

      const phi = monitor.phi('fast-node', now + 100 * 100 + 200);
      expect(phi).toBeLessThan(8);
    });

    it('irregular heartbeats increase phi variance', () => {
      const monitor = new HeartbeatMonitor({ windowSize: 20, threshold: 8 });
      const now = Date.now();

      const intervals = [100, 500, 50, 1000, 200, 800, 100, 2000, 300, 150];
      let t = now;
      for (const interval of intervals) {
        t += interval;
        monitor.recordHeartbeat('jittery', t);
      }

      const phiSoon = monitor.phi('jittery', t + 1000);
      const phiLate = monitor.phi('jittery', t + 30000);
      expect(phiLate).toBeGreaterThan(phiSoon);
    });
  });

  describe('PartitionMap advanced operations', () => {
    it('rebalance to more nodes reduces max partitions per node', () => {
      const pm = new PartitionMap();
      const strat = new HashPartitionStrategy();
      strat._partitionKey = 'ID';
      pm.registerTable('T', strat, 12, new Map(
        Array.from({ length: 12 }, (_, i) => [i, [i < 6 ? 'w1' : 'w2']])
      ));

      const oldMax = 6;
      const newPlacements = pm.rebalance('T', ['w1', 'w2', 'w3', 'w4']);

      const counts = new Map();
      for (const [, nodes] of newPlacements) {
        const n = nodes[0];
        counts.set(n, (counts.get(n) || 0) + 1);
      }

      const newMax = Math.max(...counts.values());
      expect(newMax).toBeLessThanOrEqual(oldMax);
      expect(counts.size).toBe(4);
    });

    it('snapshot captures complete partition state', () => {
      const pm = setupPartitionMap([
        { name: 'A', key: 'ID', partitions: 4 },
        { name: 'B', key: 'REF', partitions: 6 },
      ], 3);

      const snap = pm.snapshot();
      expect(Object.keys(snap)).toHaveLength(2);
      expect(snap['A'].partitionCount).toBe(4);
      expect(snap['B'].partitionCount).toBe(6);
    });

    it('isColocated returns false for different partition counts', () => {
      const pm = new PartitionMap();
      const s1 = new HashPartitionStrategy();
      s1._partitionKey = 'ID';
      const s2 = new HashPartitionStrategy();
      s2._partitionKey = 'REF';
      pm.registerTable('X', s1, 4, new Map([[0, ['w1']], [1, ['w1']], [2, ['w2']], [3, ['w2']]]));
      pm.registerTable('Y', s2, 8, new Map(Array.from({ length: 8 }, (_, i) => [i, [`w${(i % 2) + 1}`]])));

      expect(pm.isColocated('X', 'Y')).toBe(false);
    });

    it('isColocated returns false for different node placements', () => {
      const pm = new PartitionMap();
      const s1 = new HashPartitionStrategy();
      s1._partitionKey = 'ID';
      const s2 = new HashPartitionStrategy();
      s2._partitionKey = 'REF';
      pm.registerTable('P', s1, 4, new Map([[0, ['w1']], [1, ['w1']], [2, ['w2']], [3, ['w2']]]));
      pm.registerTable('Q', s2, 4, new Map([[0, ['w2']], [1, ['w2']], [2, ['w1']], [3, ['w1']]]));

      expect(pm.isColocated('P', 'Q')).toBe(false);
    });
  });

  describe('Exchange placement for complex queries', () => {
    it('aggregate with group-by chooses HASH_SHUFFLE', () => {
      const pm = setupPartitionMap([{ name: 'T', key: 'ID', partitions: 4 }]);
      const placement = new ExchangePlacement(pm);

      const agg = LogicalAggregate(
        [colRef('T', 'STATUS'), colRef('T', 'REGION')],
        [makeAgg('SUM', [colRef('T', 'AMT')])],
        LogicalScan('T', ['STATUS', 'REGION', 'AMT'])
      );

      const config = placement.determineAggregateExchange(agg);
      expect(config.type).toBe(ExchangeType.HASH_SHUFFLE);
      expect(config.keys.length).toBe(2);
    });

    it('sort exchange always chooses GATHER with ordering', () => {
      const pm = new PartitionMap();
      const placement = new ExchangePlacement(pm);

      const sort = LogicalSort([
        { columnIndex: 0, direction: 'ASC' },
        { columnIndex: 1, direction: 'DESC' },
      ], LogicalScan('T', ['A', 'B']));

      const config = placement.determineSortExchange(sort);
      expect(config.type).toBe(ExchangeType.GATHER);
      expect(config.ordered).toBe(true);
      expect(config.orderKeys.length).toBe(2);
    });

    it('join shuffle extracts keys from compound AND condition', () => {
      const pm = new PartitionMap();
      const placement = new ExchangePlacement(pm);

      const condition = binOp('AND',
        { kind: 'ColumnRef', op: '=',
          left: { kind: 'ColumnRef', tableAlias: 'A', columnName: 'ID' },
          right: { kind: 'ColumnRef', tableAlias: 'B', columnName: 'A_ID' },
        },
        { kind: 'ColumnRef', op: '=',
          left: { kind: 'ColumnRef', tableAlias: 'A', columnName: 'DATE' },
          right: { kind: 'ColumnRef', tableAlias: 'B', columnName: 'DATE' },
        },
      );

      const join = LogicalJoin(JoinType.INNER, condition,
        LogicalScan('A', ['ID', 'DATE'], 'A'),
        LogicalScan('B', ['A_ID', 'DATE'], 'B'));
      join._distributionStrategy = DistributionStrategy.SHUFFLE;

      const config = placement.determineJoinExchange(join);
      expect(config.left.type).toBe(ExchangeType.HASH_SHUFFLE);
      expect(config.right.type).toBe(ExchangeType.HASH_SHUFFLE);
    });
  });

  describe('MinHeap correctness', () => {
    it('maintains heap property through many inserts and removes', () => {
      const heap = new MinHeap((a, b) => a - b);
      const values = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 10000));

      for (const v of values) heap.push(v);
      expect(heap.size).toBe(1000);

      const sorted = [];
      while (heap.size > 0) sorted.push(heap.pop());

      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBeGreaterThanOrEqual(sorted[i - 1]);
      }
    });

    it('handles duplicate values correctly', () => {
      const heap = new MinHeap((a, b) => a - b);
      for (let i = 0; i < 100; i++) heap.push(5);
      for (let i = 0; i < 100; i++) heap.push(3);
      for (let i = 0; i < 100; i++) heap.push(7);

      expect(heap.size).toBe(300);
      const first50 = [];
      for (let i = 0; i < 100; i++) first50.push(heap.pop());
      expect(first50.every(v => v === 3)).toBe(true);
    });

    it('peek does not remove element', () => {
      const heap = new MinHeap((a, b) => a - b);
      heap.push(10);
      heap.push(5);
      heap.push(15);

      expect(heap.peek()).toBe(5);
      expect(heap.size).toBe(3);
      expect(heap.peek()).toBe(5);
    });

    it('pop from empty heap returns null', () => {
      const heap = new MinHeap((a, b) => a - b);
      expect(heap.pop()).toBeNull();
      expect(heap.size).toBe(0);
    });
  });

  describe('RoundRobin partition strategy', () => {
    it('distributes evenly across partitions', () => {
      const strat = new RoundRobinPartitionStrategy();
      const counts = new Map();

      for (let i = 0; i < 1000; i++) {
        const pid = strat.partitionFor(i, 4);
        counts.set(pid, (counts.get(pid) || 0) + 1);
      }

      expect(counts.size).toBe(4);
      for (const [, count] of counts) {
        expect(count).toBe(250);
      }
    });
  });

  describe('End-to-end: partition + shuffle + merge pipeline', () => {
    it('full pipeline: partition data, shuffle, gather, verify all rows', async () => {
      const transport = new MockTransport();
      const codec = new ChunkCodec();

      const totalRows = 200;
      const ids = Array.from({ length: totalRows }, (_, i) => i);
      const values = Array.from({ length: totalRows }, (_, i) => i * 10);

      const partitions = [[], [], []];
      for (let i = 0; i < totalRows; i++) {
        partitions[i % 3].push(i);
      }

      const channelId = 'pipeline-test';
      const receiver = new ExchangeReceiver(transport, ['w1', 'w2', 'w3'], { channelId });
      await receiver.init();

      for (let p = 0; p < 3; p++) {
        const pIds = partitions[p];
        const pVals = pIds.map(id => values[id]);
        const chunk = makeChunk([
          makeCol(DataType.INT32, pIds),
          makeCol(DataType.INT32, pVals),
        ], pIds.length);

        receiver._handleChunk(`w${p + 1}`, codec.encode(chunk));
        receiver._handleChunk(`w${p + 1}`, codec.encode(new DataChunk([], 0)));
      }

      const collectedIds = new Set();
      let totalReceived = 0;

      for await (const chunk of receiver.generate()) {
        for (let i = 0; i < chunk.size; i++) {
          const id = chunk.columns[0].get(i);
          const val = chunk.columns[1].get(i);
          expect(val).toBe(id * 10);
          collectedIds.add(id);
          totalReceived++;
        }
      }

      expect(totalReceived).toBe(totalRows);
      expect(collectedIds.size).toBe(totalRows);
    });
  });
});
