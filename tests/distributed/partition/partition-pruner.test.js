import { describe, it, expect, beforeEach } from 'vitest';
import { PartitionPruner } from '../../../src/distributed/partition/partition-pruner.js';
import { PartitionMap } from '../../../src/distributed/partition/partition-map.js';
import { HashPartitionStrategy, RangePartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function colRef(columnName) {
  return { kind: BoundExprKind.COLUMN_REF, columnName, tableAlias: 'T' };
}

function literal(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function eq(left, right) {
  return { kind: BoundExprKind.BINARY, op: '=', left, right };
}

function and(left, right) {
  return { kind: BoundExprKind.BINARY, op: 'AND', left, right };
}

function or(left, right) {
  return { kind: BoundExprKind.BINARY, op: 'OR', left, right };
}

function lt(left, right) {
  return { kind: BoundExprKind.BINARY, op: '<', left, right };
}

function lte(left, right) {
  return { kind: BoundExprKind.BINARY, op: '<=', left, right };
}

function gt(left, right) {
  return { kind: BoundExprKind.BINARY, op: '>', left, right };
}

function gte(left, right) {
  return { kind: BoundExprKind.BINARY, op: '>=', left, right };
}

describe('PartitionPruner', () => {
  let pruner;
  let pm;

  beforeEach(() => {
    pruner = new PartitionPruner();
    pm = new PartitionMap();
  });

  describe('hash partitioned tables', () => {
    let strategy;

    beforeEach(() => {
      strategy = new HashPartitionStrategy();
      strategy._partitionKey = 'ID';
      pm.registerTable('orders', strategy, 8, new Map());
    });

    it('returns all partitions with no predicate', () => {
      const result = pruner.prune('orders', null, pm);
      expect(result.size).toBe(8);
      for (let i = 0; i < 8; i++) expect(result.has(i)).toBe(true);
    });

    it('prunes to the mathematically correct partition on equality', () => {
      const pred = eq(colRef('ID'), literal(42));
      const result = pruner.prune('orders', pred, pm);

      expect(result.size).toBe(1);
      const expectedPid = strategy.partitionFor(42, 8);
      expect(result.has(expectedPid)).toBe(true);
    });

    it('prunes different values to their correct partitions', () => {
      for (const val of [0, 1, 99, 1000, -5]) {
        const pred = eq(colRef('ID'), literal(val));
        const result = pruner.prune('orders', pred, pm);
        const expectedPid = strategy.partitionFor(val, 8);
        expect(result.size).toBe(1);
        expect(result.has(expectedPid)).toBe(true);
      }
    });

    it('returns all partitions for non-partition-key predicate', () => {
      const pred = eq(colRef('STATUS'), literal('active'));
      const result = pruner.prune('orders', pred, pm);
      expect(result.size).toBe(8);
    });

    it('AND with equality on partition key and non-key narrows to 1', () => {
      const pred = and(
        eq(colRef('ID'), literal(42)),
        eq(colRef('STATUS'), literal('active'))
      );
      const result = pruner.prune('orders', pred, pm);
      expect(result.size).toBe(1);
      expect(result.has(strategy.partitionFor(42, 8))).toBe(true);
    });

    it('AND of two equality predicates on partition key intersects', () => {
      const pred = and(
        eq(colRef('ID'), literal(10)),
        eq(colRef('ID'), literal(20))
      );
      const result = pruner.prune('orders', pred, pm);

      const p10 = strategy.partitionFor(10, 8);
      const p20 = strategy.partitionFor(20, 8);
      if (p10 === p20) {
        expect(result.size).toBe(1);
      } else {
        expect(result.size).toBe(0);
      }
    });

    it('OR of two equalities unions the partitions', () => {
      const pred = or(
        eq(colRef('ID'), literal(10)),
        eq(colRef('ID'), literal(20))
      );
      const result = pruner.prune('orders', pred, pm);

      const p10 = strategy.partitionFor(10, 8);
      const p20 = strategy.partitionFor(20, 8);
      expect(result.has(p10)).toBe(true);
      expect(result.has(p20)).toBe(true);
      if (p10 === p20) {
        expect(result.size).toBe(1);
      } else {
        expect(result.size).toBe(2);
      }
    });

    it('IN list prunes to exact set of target partitions', () => {
      const values = [10, 20, 30];
      const pred = {
        kind: BoundExprKind.IN_LIST,
        expr: colRef('ID'),
        values: values.map(v => literal(v)),
      };
      const result = pruner.prune('orders', pred, pm);

      const expectedPids = new Set(values.map(v => strategy.partitionFor(v, 8)));
      expect(result.size).toBe(expectedPids.size);
      for (const pid of expectedPids) {
        expect(result.has(pid)).toBe(true);
      }
    });

    it('equality with column on right side still prunes', () => {
      const pred = eq(literal(42), colRef('ID'));
      const result = pruner.prune('orders', pred, pm);
      expect(result.size).toBe(1);
      expect(result.has(strategy.partitionFor(42, 8))).toBe(true);
    });
  });

  describe('range partitioned tables', () => {
    let strategy;

    beforeEach(() => {
      strategy = new RangePartitionStrategy([100, 200, 300]);
      strategy._partitionKey = 'AMOUNT';
      pm.registerTable('sales', strategy, 4, new Map());
    });

    it('prunes equality to the correct range partition', () => {
      expect(strategy.partitionFor(50)).toBe(0);
      expect(strategy.partitionFor(150)).toBe(1);
      expect(strategy.partitionFor(250)).toBe(2);
      expect(strategy.partitionFor(350)).toBe(3);

      for (const [val, expectedPid] of [[50, 0], [150, 1], [250, 2], [350, 3]]) {
        const result = pruner.prune('sales', eq(colRef('AMOUNT'), literal(val)), pm);
        expect(result.size).toBe(1);
        expect(result.has(expectedPid)).toBe(true);
      }
    });

    it('prunes < to correct lower partitions', () => {
      const pred = lt(colRef('AMOUNT'), literal(200));
      const result = pruner.prune('sales', pred, pm);

      const targetPid = strategy.partitionFor(200);
      for (let p = 0; p <= targetPid; p++) {
        expect(result.has(p)).toBe(true);
      }
      for (let p = targetPid + 1; p < 4; p++) {
        expect(result.has(p)).toBe(false);
      }
    });

    it('prunes <= to correct lower partitions', () => {
      const pred = lte(colRef('AMOUNT'), literal(150));
      const result = pruner.prune('sales', pred, pm);

      const targetPid = strategy.partitionFor(150);
      for (let p = 0; p <= targetPid; p++) {
        expect(result.has(p)).toBe(true);
      }
    });

    it('prunes >= to correct upper partitions', () => {
      const pred = gte(colRef('AMOUNT'), literal(200));
      const result = pruner.prune('sales', pred, pm);

      const targetPid = strategy.partitionFor(200);
      for (let p = targetPid; p < 4; p++) {
        expect(result.has(p)).toBe(true);
      }
      for (let p = 0; p < targetPid; p++) {
        expect(result.has(p)).toBe(false);
      }
    });

    it('prunes > to correct upper partitions', () => {
      const pred = gt(colRef('AMOUNT'), literal(100));
      const result = pruner.prune('sales', pred, pm);

      const targetPid = strategy.partitionFor(100);
      for (let p = targetPid; p < 4; p++) {
        expect(result.has(p)).toBe(true);
      }
    });

    it('BETWEEN prunes to exact range of partitions', () => {
      const pred = {
        kind: BoundExprKind.BETWEEN,
        expr: colRef('AMOUNT'),
        low: literal(50),
        high: literal(250),
      };
      const result = pruner.prune('sales', pred, pm);

      const lowPid = strategy.partitionFor(50);
      const highPid = strategy.partitionFor(250);
      expect(result.size).toBe(highPid - lowPid + 1);
      for (let p = lowPid; p <= highPid; p++) {
        expect(result.has(p)).toBe(true);
      }
    });

    it('BETWEEN on single partition', () => {
      const pred = {
        kind: BoundExprKind.BETWEEN,
        expr: colRef('AMOUNT'),
        low: literal(110),
        high: literal(190),
      };
      const result = pruner.prune('sales', pred, pm);
      expect(result.size).toBe(1);
      expect(result.has(1)).toBe(true);
    });

    it('AND of range predicates intersects correctly', () => {
      const pred = and(
        gte(colRef('AMOUNT'), literal(100)),
        lt(colRef('AMOUNT'), literal(300))
      );
      const result = pruner.prune('sales', pred, pm);

      const gePid = strategy.partitionFor(100);
      const ltPid = strategy.partitionFor(300);

      const geSet = new Set();
      for (let p = gePid; p < 4; p++) geSet.add(p);

      const ltSet = new Set();
      for (let p = 0; p <= ltPid; p++) ltSet.add(p);

      const expected = new Set([...geSet].filter(p => ltSet.has(p)));
      expect(result.size).toBe(expected.size);
      for (const p of expected) expect(result.has(p)).toBe(true);
    });

    it('column on right side flips operator correctly', () => {
      const pred = { kind: BoundExprKind.BINARY, op: '<', left: literal(200), right: colRef('AMOUNT') };
      const result = pruner.prune('sales', pred, pm);

      const targetPid = strategy.partitionFor(200);
      for (let p = targetPid; p < 4; p++) {
        expect(result.has(p)).toBe(true);
      }
    });
  });

  it('returns empty set for unknown table', () => {
    const result = pruner.prune('unknown', eq(colRef('ID'), literal(1)), pm);
    expect(result.size).toBe(0);
  });

  it('OR where one side is non-prunable returns null (all partitions)', () => {
    const strategy = new HashPartitionStrategy();
    strategy._partitionKey = 'ID';
    pm.registerTable('t', strategy, 4, new Map());

    const pred = or(
      eq(colRef('ID'), literal(1)),
      { kind: BoundExprKind.BINARY, op: '>', left: colRef('NAME'), right: literal('z') }
    );
    const result = pruner.prune('t', pred, pm);
    expect(result.size).toBe(4);
  });
});
