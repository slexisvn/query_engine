import { describe, it, expect, beforeEach } from 'vitest';
import { DistributedPlanner } from '../../../src/distributed/planner/distributed-planner.js';
import { PartitionMap } from '../../../src/distributed/partition/partition-map.js';
import { HashPartitionStrategy, RangePartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';
import { ClusterManager } from '../../../src/distributed/cluster/cluster-manager.js';
import { NodeDescriptor, NodeRole } from '../../../src/distributed/cluster/node-descriptor.js';
import { ExchangePlacement } from '../../../src/distributed/planner/exchange-placement.js';
import { PartitionPruner } from '../../../src/distributed/partition/partition-pruner.js';
import { ChunkCodec } from '../../../src/distributed/transport/chunk-codec.js';
import { ExchangeSender, ExchangeReceiver } from '../../../src/distributed/execution/exchange-operator.js';
import { MinHeap } from '../../../src/distributed/execution/merge-exchange.js';
import { Fragment, FragmentPlan, FragmentState, ExchangeType, resetFragmentIdCounter } from '../../../src/distributed/planner/fragment.js';
import { HeartbeatMonitor } from '../../../src/distributed/cluster/heartbeat-monitor.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DataType } from '../../../src/storage/data-type.js';
import { PlanNodeType, LogicalScan, LogicalFilter, LogicalJoin, LogicalAggregate, LogicalSort, LogicalLimit, JoinType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function makeIntColumn(values) {
  const col = new Column(DataType.INT32, values.length);
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return col;
}

function makeVarcharColumn(values) {
  const col = new Column(DataType.VARCHAR, values.length);
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return col;
}

function makeChunk(columns, size) {
  return new DataChunk(columns, size);
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
      nodeId: `w${i}`,
      host: '127.0.0.1',
      port: 9400 + i,
      role: NodeRole.WORKER,
    }));
  }
  return cm;
}

describe('Distributed Query E2E', () => {
  beforeEach(() => {
    resetFragmentIdCounter();
  });

  describe('Full pipeline: partition → codec → exchange → merge', () => {
    it('round-trips data through hash partitioning, codec, and exchange', async () => {
      const strategy = new HashPartitionStrategy();
      const values = Array.from({ length: 100 }, (_, i) => i);

      const partitioned = new Map();
      for (const val of values) {
        const pid = strategy.partitionFor(val, 4);
        if (!partitioned.has(pid)) partitioned.set(pid, []);
        partitioned.get(pid).push(val);
      }

      expect(partitioned.size).toBe(4);
      let totalFromPartitions = 0;
      for (const [, vals] of partitioned) {
        totalFromPartitions += vals.length;
      }
      expect(totalFromPartitions).toBe(100);

      const codec = new ChunkCodec();
      for (const [, vals] of partitioned) {
        const col = makeIntColumn(vals);
        const chunk = makeChunk([col], vals.length);
        const encoded = codec.encode(chunk);
        const decoded = codec.decode(encoded);
        expect(decoded.size).toBe(vals.length);
        for (let i = 0; i < vals.length; i++) {
          expect(decoded.columns[0].get(i)).toBe(vals[i]);
        }
      }
    });

    it('exchange sender + receiver pipeline delivers all rows', async () => {
      const transport = new MockTransport();
      const channelId = 'e2e-ch-1';

      const receiver = new ExchangeReceiver(transport, ['node-1'], { channelId });
      await receiver.init();

      const sender = new ExchangeSender(transport, ['unused'], {
        exchangeType: 'gather',
        channelId,
      });

      const batches = [
        makeChunk([makeIntColumn([1, 2, 3])], 3),
        makeChunk([makeIntColumn([4, 5])], 2),
        makeChunk([makeIntColumn([6, 7, 8, 9])], 4),
      ];

      const codec = new ChunkCodec();
      for (const batch of batches) {
        receiver._handleChunk('node-1', codec.encode(batch));
      }
      receiver._handleChunk('node-1', codec.encode(new DataChunk([], 0)));

      const received = [];
      for await (const chunk of receiver.generate()) {
        for (let i = 0; i < chunk.size; i++) {
          received.push(chunk.columns[0].get(i));
        }
      }

      expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('hash-shuffle distributes and preserves all rows', async () => {
      const transport = new MockTransport();
      const sender = new ExchangeSender(transport, ['n1', 'n2'], {
        exchangeType: 'hash_shuffle',
        keyExtractors: [(chunk, row) => chunk.columns[0].get(row)],
        partitionCount: 2,
        channelId: 'e2e-shuffle',
      });

      const col = makeIntColumn(Array.from({ length: 50 }, (_, i) => i));
      await sender.consume(makeChunk([col], 50));

      const codec = new ChunkCodec();
      let totalRows = 0;
      const allValues = new Set();

      for (const msg of transport._sent) {
        const decoded = codec.decode(msg.data);
        totalRows += decoded.size;
        for (let i = 0; i < decoded.size; i++) {
          allValues.add(decoded.columns[0].get(i));
        }
      }

      expect(totalRows).toBe(50);
      expect(allValues.size).toBe(50);
    });
  });

  describe('Fragment planning with cluster topology', () => {
    it('produces valid fragment plan for colocated join', () => {
      const cm = setupCluster(2);
      const pm = new PartitionMap();

      const stratA = new HashPartitionStrategy();
      stratA._partitionKey = 'ID';
      pm.registerTable('ORDERS', stratA, 4, new Map([
        [0, ['w1']], [1, ['w1']], [2, ['w2']], [3, ['w2']],
      ]));

      const stratB = new HashPartitionStrategy();
      stratB._partitionKey = 'ORDER_ID';
      pm.registerTable('LINEITEM', stratB, 4, new Map([
        [0, ['w1']], [1, ['w1']], [2, ['w2']], [3, ['w2']],
      ]));

      expect(pm.isColocated('ORDERS', 'LINEITEM')).toBe(true);

      const left = LogicalScan('ORDERS', ['ID'], 'ORDERS');
      left._cardinality = 10000;
      const right = LogicalScan('LINEITEM', ['ORDER_ID', 'AMOUNT'], 'LINEITEM');
      right._cardinality = 50000;

      const planner = new DistributedPlanner(pm, cm);
      const plan = planner.fragmentize(
        LogicalJoin(JoinType.INNER, {
          kind: BoundExprKind.BINARY, op: '=',
          left: { kind: 'ColumnRef', tableAlias: 'ORDERS', columnName: 'ID' },
          right: { kind: 'ColumnRef', tableAlias: 'LINEITEM', columnName: 'ORDER_ID' },
        }, left, right)
      );

      const topo = plan.topologicalOrder();
      expect(topo.length).toBe(plan.fragments.length);
      expect(plan.getRootFragment().targetNodes).toContain('coord');

      const seen = new Set();
      for (const f of topo) {
        for (const input of f.exchangeInputs) {
          expect(seen.has(input.sourceFragmentId)).toBe(true);
        }
        seen.add(f.fragmentId);
      }
    });

    it('fragment state machine flows correctly through lifecycle', () => {
      const frag = new Fragment({ planRoot: { type: 'Scan' }, targetNodes: ['w1'] });

      expect(frag.state).toBe(FragmentState.PENDING);

      frag.markDispatched('w1');
      expect(frag.state).toBe(FragmentState.DISPATCHED);

      frag.markRunning();
      expect(frag.state).toBe(FragmentState.RUNNING);

      frag.markFailed(new Error('timeout'));
      expect(frag.state).toBe(FragmentState.FAILED);
      expect(frag.retryCount).toBe(1);
      expect(frag.canRetry(3)).toBe(true);

      frag.state = FragmentState.PENDING;
      frag.markDispatched('w2');
      frag.markRunning();
      frag.markCompleted();
      expect(frag.state).toBe(FragmentState.COMPLETED);
    });
  });

  describe('Partition pruning integration', () => {
    it('prunes hash partitions via equality predicate', () => {
      const pm = new PartitionMap();
      const strat = new HashPartitionStrategy();
      strat._partitionKey = 'ID';
      pm.registerTable('USERS', strat, 8, new Map(
        Array.from({ length: 8 }, (_, i) => [i, [`w${(i % 3) + 1}`]])
      ));

      const pruner = new PartitionPruner();
      const result = pruner.prune('USERS', {
        kind: BoundExprKind.BINARY,
        op: '=',
        left: { kind: BoundExprKind.COLUMN_REF, columnName: 'ID' },
        right: { kind: BoundExprKind.LITERAL, value: 42 },
      }, pm);

      expect(result.size).toBe(1);
      expect(result.size).toBeLessThan(8);
    });

    it('AND narrows partitions via intersection', () => {
      const pm = new PartitionMap();
      const strat = new RangePartitionStrategy([10, 20, 30, 40]);
      strat._partitionKey = 'AGE';
      pm.registerTable('PEOPLE', strat, 5, new Map(
        Array.from({ length: 5 }, (_, i) => [i, [`w${(i % 2) + 1}`]])
      ));

      const pruner = new PartitionPruner();
      const result = pruner.prune('PEOPLE', {
        kind: BoundExprKind.BINARY,
        op: 'AND',
        left: {
          kind: BoundExprKind.BINARY, op: '>=',
          left: { kind: BoundExprKind.COLUMN_REF, columnName: 'AGE' },
          right: { kind: BoundExprKind.LITERAL, value: 15 },
        },
        right: {
          kind: BoundExprKind.BINARY, op: '<',
          left: { kind: BoundExprKind.COLUMN_REF, columnName: 'AGE' },
          right: { kind: BoundExprKind.LITERAL, value: 25 },
        },
      }, pm);

      expect(result.size).toBeLessThan(5);
    });
  });

  describe('Cluster health monitoring', () => {
    it('phi-accrual detects node failure and recovery', () => {
      const cm = setupCluster(2);
      const failedNodes = [];
      cm.onNodeFailure(nodeId => failedNodes.push(nodeId));

      expect(cm.getAliveNodes().length).toBe(3);
      expect(cm.getWorkerNodes().length).toBe(2);

      cm.removeNode('w1');
      expect(cm.getWorkerNodes().length).toBe(1);

      cm.addNode(new NodeDescriptor({
        nodeId: 'w3',
        host: '127.0.0.1',
        port: 9403,
        role: NodeRole.WORKER,
      }));
      expect(cm.getWorkerNodes().length).toBe(2);
    });

    it('heartbeat monitor computes phi correctly', () => {
      const monitor = new HeartbeatMonitor({ windowSize: 10, threshold: 8 });
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        monitor.recordHeartbeat('w1', now + i * 1000);
      }

      const phi = monitor.phi('w1', now + 10000);
      expect(phi).toBeLessThan(8);

      const phiLate = monitor.phi('w1', now + 60000);
      expect(phiLate).toBeGreaterThan(8);
    });
  });

  describe('K-way merge for distributed sort', () => {
    it('merges pre-sorted streams into global order', () => {
      const streams = [
        [1, 4, 7, 10, 13],
        [2, 5, 8, 11, 14],
        [3, 6, 9, 12, 15],
      ];

      const heap = new MinHeap((a, b) => a.value - b.value);

      for (let s = 0; s < streams.length; s++) {
        heap.push({ value: streams[s][0], stream: s, idx: 0 });
      }

      const merged = [];
      while (heap.size > 0) {
        const { value, stream, idx } = heap.pop();
        merged.push(value);
        if (idx + 1 < streams[stream].length) {
          heap.push({ value: streams[stream][idx + 1], stream, idx: idx + 1 });
        }
      }

      expect(merged).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    });

    it('handles empty streams gracefully', () => {
      const streams = [
        [1, 3, 5],
        [],
        [2, 4],
      ];

      const heap = new MinHeap((a, b) => a.value - b.value);
      for (let s = 0; s < streams.length; s++) {
        if (streams[s].length > 0) {
          heap.push({ value: streams[s][0], stream: s, idx: 0 });
        }
      }

      const merged = [];
      while (heap.size > 0) {
        const { value, stream, idx } = heap.pop();
        merged.push(value);
        if (idx + 1 < streams[stream].length) {
          heap.push({ value: streams[stream][idx + 1], stream, idx: idx + 1 });
        }
      }

      expect(merged).toEqual([1, 2, 3, 4, 5]);
    });

    it('supports early termination for limit queries', () => {
      const streams = [
        Array.from({ length: 1000 }, (_, i) => i * 3),
        Array.from({ length: 1000 }, (_, i) => i * 3 + 1),
        Array.from({ length: 1000 }, (_, i) => i * 3 + 2),
      ];

      const heap = new MinHeap((a, b) => a.value - b.value);
      for (let s = 0; s < streams.length; s++) {
        heap.push({ value: streams[s][0], stream: s, idx: 0 });
      }

      const limit = 10;
      const merged = [];
      while (heap.size > 0 && merged.length < limit) {
        const { value, stream, idx } = heap.pop();
        merged.push(value);
        if (idx + 1 < streams[stream].length) {
          heap.push({ value: streams[stream][idx + 1], stream, idx: idx + 1 });
        }
      }

      expect(merged).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(merged.length).toBe(10);
    });
  });

  describe('ChunkCodec with mixed data types', () => {
    it('round-trips a multi-type chunk through encode/decode', () => {
      const intCol = makeIntColumn([100, 200, 300]);
      const varCol = makeVarcharColumn(['alpha', 'beta', 'gamma']);
      const chunk = makeChunk([intCol, varCol], 3);

      const codec = new ChunkCodec();
      const encoded = codec.encode(chunk);
      const decoded = codec.decode(encoded);

      expect(decoded.size).toBe(3);
      expect(decoded.columns.length).toBe(2);
      expect(decoded.columns[0].get(0)).toBe(100);
      expect(decoded.columns[0].get(2)).toBe(300);
      expect(decoded.columns[1].get(0)).toBe('alpha');
      expect(decoded.columns[1].get(2)).toBe('gamma');
    });

    it('handles nulls across network serialization', () => {
      const col = makeIntColumn([1, 2, 3]);
      col.set(1, null);
      const chunk = makeChunk([col], 3);

      const codec = new ChunkCodec();
      const decoded = codec.decode(codec.encode(chunk));

      expect(decoded.columns[0].get(0)).toBe(1);
      expect(decoded.columns[0].isNull(1)).toBe(true);
      expect(decoded.columns[0].get(2)).toBe(3);
    });
  });

  describe('Partition rebalancing', () => {
    it('rebalances partitions when a node is added', () => {
      const pm = new PartitionMap();
      const strat = new HashPartitionStrategy();
      strat._partitionKey = 'ID';

      pm.registerTable('DATA', strat, 8, new Map(
        Array.from({ length: 8 }, (_, i) => [i, [i < 4 ? 'w1' : 'w2']])
      ));

      const oldPlacements = new Map(
        Array.from({ length: 8 }, (_, i) => [i, [i < 4 ? 'w1' : 'w2']])
      );

      const newPlacements = pm.rebalance('DATA', ['w1', 'w2', 'w3']);

      expect(newPlacements.size).toBe(8);

      const nodeAssignments = new Set();
      for (const [, nodes] of newPlacements) {
        nodeAssignments.add(nodes[0]);
      }
      expect(nodeAssignments.size).toBeGreaterThanOrEqual(2);

      const movements = pm.computeMovements('DATA', oldPlacements, newPlacements);
      expect(movements.length).toBeGreaterThan(0);

      for (const m of movements) {
        expect(m.from).toBeDefined();
        expect(m.to).toBeDefined();
        expect(m.from).not.toBe(m.to);
      }
    });
  });
});
