import { describe, it, expect } from 'vitest';
import { ExchangePlacement } from '../../../src/distributed/planner/exchange-placement.js';
import { PartitionMap } from '../../../src/distributed/partition/partition-map.js';
import { HashPartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';
import { DistributionStrategy } from '../../../src/distributed/optimizer/distribution-aware-join.js';
import { ExchangeType } from '../../../src/distributed/planner/fragment.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function makeJoinNode(distStrategy, condition) {
  return {
    type: 'Join',
    joinType: 'INNER',
    _distributionStrategy: distStrategy,
    condition,
    children: [{}, {}],
  };
}

function makeEquiCondition() {
  return {
    kind: BoundExprKind.BINARY,
    op: '=',
    left: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'A', columnName: 'K' },
    right: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'B', columnName: 'K' },
  };
}

describe('ExchangePlacement', () => {
  const pm = new PartitionMap();
  const ep = new ExchangePlacement(pm);

  describe('determineJoinExchange', () => {
    it('returns passthrough for colocated joins', () => {
      const node = makeJoinNode(DistributionStrategy.COLOCATED, makeEquiCondition());
      const result = ep.determineJoinExchange(node);

      expect(result.left.type).toBe(ExchangeType.PASSTHROUGH);
      expect(result.right.type).toBe(ExchangeType.PASSTHROUGH);
    });

    it('returns broadcast left for broadcast_left strategy', () => {
      const node = makeJoinNode(DistributionStrategy.BROADCAST_LEFT, makeEquiCondition());
      const result = ep.determineJoinExchange(node);

      expect(result.left.type).toBe(ExchangeType.BROADCAST);
      expect(result.right.type).toBe(ExchangeType.PASSTHROUGH);
    });

    it('returns broadcast right for broadcast_right strategy', () => {
      const node = makeJoinNode(DistributionStrategy.BROADCAST_RIGHT, makeEquiCondition());
      const result = ep.determineJoinExchange(node);

      expect(result.left.type).toBe(ExchangeType.PASSTHROUGH);
      expect(result.right.type).toBe(ExchangeType.BROADCAST);
    });

    it('returns hash shuffle for shuffle strategy', () => {
      const node = makeJoinNode(DistributionStrategy.SHUFFLE, makeEquiCondition());
      const result = ep.determineJoinExchange(node);

      expect(result.left.type).toBe(ExchangeType.HASH_SHUFFLE);
      expect(result.right.type).toBe(ExchangeType.HASH_SHUFFLE);
    });

    it('extracts equi-join column refs as shuffle keys', () => {
      const node = makeJoinNode(DistributionStrategy.SHUFFLE, makeEquiCondition());
      const result = ep.determineJoinExchange(node);

      expect(result.left.keys).toHaveLength(1);
      expect(result.right.keys).toHaveLength(1);
      expect(result.left.keys[0]).toMatchObject({ tableAlias: 'A', columnName: 'K' });
      expect(result.right.keys[0]).toMatchObject({ tableAlias: 'B', columnName: 'K' });
    });
  });

  describe('determineAggregateExchange', () => {
    it('returns gather for ungrouped aggregate', () => {
      const node = { groupBy: [] };
      const result = ep.determineAggregateExchange(node);
      expect(result.type).toBe(ExchangeType.GATHER);
    });

    it('returns hash shuffle on group keys for grouped aggregate', () => {
      const node = { groupBy: [{ columnName: 'STATUS' }] };
      const result = ep.determineAggregateExchange(node);
      expect(result.type).toBe(ExchangeType.HASH_SHUFFLE);
      expect(result.keys.length).toBe(1);
    });
  });

  describe('determineSortExchange', () => {
    it('returns gather with order info', () => {
      const node = { orderKeys: [{ expr: { columnName: 'ID' }, direction: 'ASC' }] };
      const result = ep.determineSortExchange(node);
      expect(result.type).toBe(ExchangeType.GATHER);
      expect(result.ordered).toBe(true);
    });
  });
});
