import { describe, it, expect, beforeEach } from 'vitest';
import { PartitionMap } from '../../../src/distributed/partition/partition-map.js';
import { HashPartitionStrategy, RangePartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';

describe('PartitionMap', () => {
  let pm;

  beforeEach(() => {
    pm = new PartitionMap();
  });

  it('registers and retrieves table info', () => {
    const strategy = new HashPartitionStrategy();
    pm.registerTable('orders', strategy, 4, new Map([
      [0, ['node-1']], [1, ['node-1']], [2, ['node-2']], [3, ['node-2']],
    ]));

    const info = pm.getTableInfo('orders');
    expect(info).not.toBeNull();
    expect(info.partitionCount).toBe(4);
    expect(info.strategy.type).toBe('hash');
  });

  it('is case-insensitive for table names', () => {
    pm.registerTable('Orders', new HashPartitionStrategy(), 4, new Map());
    expect(pm.getTableInfo('ORDERS')).not.toBeNull();
    expect(pm.getTableInfo('orders')).not.toBeNull();
  });

  it('returns null for unregistered table', () => {
    expect(pm.getTableInfo('nonexistent')).toBeNull();
  });

  it('getPartitionsForNode returns correct partitions', () => {
    pm.registerTable('orders', new HashPartitionStrategy(), 4, new Map([
      [0, ['node-1']], [1, ['node-1']], [2, ['node-2']], [3, ['node-2']],
    ]));

    expect(pm.getPartitionsForNode('orders', 'node-1').sort()).toEqual([0, 1]);
    expect(pm.getPartitionsForNode('orders', 'node-2').sort()).toEqual([2, 3]);
    expect(pm.getPartitionsForNode('orders', 'node-3')).toEqual([]);
  });

  it('getNodesForPartition returns correct nodes', () => {
    pm.registerTable('orders', new HashPartitionStrategy(), 2, new Map([
      [0, ['node-1', 'node-2']], [1, ['node-2']],
    ]));

    expect(pm.getNodesForPartition('orders', 0)).toEqual(['node-1', 'node-2']);
    expect(pm.getNodesForPartition('orders', 1)).toEqual(['node-2']);
    expect(pm.getNodesForPartition('orders', 99)).toEqual([]);
  });

  it('getAllPartitionIds returns 0..n-1', () => {
    pm.registerTable('orders', new HashPartitionStrategy(), 4, new Map());
    expect(pm.getAllPartitionIds('orders')).toEqual([0, 1, 2, 3]);
  });

  it('isColocated returns true for matching hash tables', () => {
    const strat = new HashPartitionStrategy();
    const placements = new Map([
      [0, ['node-1']], [1, ['node-2']],
    ]);

    pm.registerTable('orders', strat, 2, placements);
    pm.registerTable('lineitem', strat, 2, placements);

    expect(pm.isColocated('orders', 'lineitem')).toBe(true);
  });

  it('isColocated returns false for different partition counts', () => {
    const strat = new HashPartitionStrategy();
    pm.registerTable('orders', strat, 4, new Map());
    pm.registerTable('lineitem', strat, 8, new Map());

    expect(pm.isColocated('orders', 'lineitem')).toBe(false);
  });

  it('isColocated returns false for different strategy types', () => {
    pm.registerTable('orders', new HashPartitionStrategy(), 4, new Map());
    pm.registerTable('lineitem', new RangePartitionStrategy([10, 20, 30]), 4, new Map());

    expect(pm.isColocated('orders', 'lineitem')).toBe(false);
  });

  it('isColocated returns false for different placements', () => {
    const strat = new HashPartitionStrategy();
    pm.registerTable('orders', strat, 2, new Map([
      [0, ['node-1']], [1, ['node-2']],
    ]));
    pm.registerTable('lineitem', strat, 2, new Map([
      [0, ['node-2']], [1, ['node-1']],
    ]));

    expect(pm.isColocated('orders', 'lineitem')).toBe(false);
  });

  it('rebalance distributes partitions across new nodes', () => {
    pm.registerTable('orders', new HashPartitionStrategy(), 6, new Map([
      [0, ['old-1']], [1, ['old-1']], [2, ['old-1']],
      [3, ['old-1']], [4, ['old-1']], [5, ['old-1']],
    ]));

    const newPlacements = pm.rebalance('orders', ['new-1', 'new-2', 'new-3']);
    expect(newPlacements.size).toBe(6);

    const nodeSet = new Set();
    for (const [_, nodes] of newPlacements) {
      nodeSet.add(nodes[0]);
    }
    expect(nodeSet.size).toBe(3);
  });

  it('computeMovements identifies partition migrations', () => {
    const old = new Map([[0, ['node-1']], [1, ['node-2']]]);
    const next = new Map([[0, ['node-2']], [1, ['node-2']]]);

    const moves = pm.computeMovements('orders', old, next);
    expect(moves.length).toBe(1);
    expect(moves[0]).toEqual({ partitionId: 0, from: 'node-1', to: 'node-2' });
  });

  it('snapshot returns serializable state', () => {
    pm.registerTable('orders', new HashPartitionStrategy(), 2, new Map([
      [0, ['node-1']], [1, ['node-2']],
    ]));

    const snap = pm.snapshot();
    expect(snap.ORDERS).toBeDefined();
    expect(snap.ORDERS.partitionCount).toBe(2);
  });
  describe('replicated tables', () => {
    it('reports a registered replicated table', () => {
      pm.registerReplicatedTable('dim');

      expect(pm.isReplicated('dim')).toBe(true);
    });

    it('is case-insensitive for replicated table names', () => {
      pm.registerReplicatedTable('Dim');

      expect(pm.isReplicated('DIM')).toBe(true);
    });

    it('reports an unknown table as not replicated', () => {
      expect(pm.isReplicated('missing')).toBe(false);
    });

    it('reports a partitioned table as not replicated', () => {
      pm.registerTable('orders', new HashPartitionStrategy(), 2, new Map());

      expect(pm.isReplicated('orders')).toBe(false);
    });

    it('keeps a replicated table out of the partitioned table info', () => {
      pm.registerReplicatedTable('dim');

      expect(pm.getTableInfo('dim')).toBeNull();
    });

    it('stops reporting a table as replicated once it is partitioned', () => {
      pm.registerReplicatedTable('dim');
      pm.registerTable('dim', new HashPartitionStrategy(), 2, new Map());

      expect(pm.isReplicated('dim')).toBe(false);
      expect(pm.getTableInfo('dim')).not.toBeNull();
    });

    it('stops reporting a table as partitioned once it is replicated', () => {
      pm.registerTable('dim', new HashPartitionStrategy(), 2, new Map());
      pm.registerReplicatedTable('dim');

      expect(pm.getTableInfo('dim')).toBeNull();
      expect(pm.isReplicated('dim')).toBe(true);
    });
  });
});
