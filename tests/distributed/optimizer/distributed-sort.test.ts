import { describe, it, expect } from 'vitest';
import { DistributedSortPass } from '../../../src/distributed/optimizer/distributed-sort.js';
import { PlanNodeType, LogicalScan, LogicalSort, LogicalExchange } from '../../../src/planner/logical-plan.js';
import { ExchangeType } from '../../../src/distributed/planner/fragment.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function colRef(name) {
  return { kind: BoundExprKind.COLUMN_REF, columnName: name, tableAlias: 'T' };
}

function orderKey(name, dir = 'ASC') {
  return { expr: colRef(name), direction: dir };
}

describe('DistributedSortPass', () => {
  const pass = new DistributedSortPass();

  it('skips non-distributed plans', () => {
    const scan = LogicalScan('T', []);
    const sort = LogicalSort([orderKey('ID')], scan);

    const result = pass.apply(sort);
    expect(result.type).toBe(PlanNodeType.SORT);
  });

  it('rewrites sort above exchange into local sort + merge exchange', () => {
    const scan = LogicalScan('T', []);
    const exchange = LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 4, scan);
    const sort = LogicalSort([orderKey('ID')], exchange);
    sort._distributed = true;
    sort._cardinality = 1000;

    const result = pass.apply(sort);
    expect(result.type).toBe(PlanNodeType.MERGE_EXCHANGE);
    expect(result.children[0].type).toBe(PlanNodeType.SORT);
  });

  it('preserves order keys in merge exchange', () => {
    const scan = LogicalScan('T', []);
    const exchange = LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 4, scan);
    const keys = [orderKey('NAME', 'DESC'), orderKey('ID', 'ASC')];
    const sort = LogicalSort(keys, exchange);
    sort._distributed = true;

    const result = pass.apply(sort);
    expect(result.orderKeys.length).toBe(2);
    expect(result.orderKeys[0].direction).toBe('DESC');
    expect(result.orderKeys[1].direction).toBe('ASC');
  });

  it('rewrites TopN above exchange into local TopN + merge exchange + limit', () => {
    const scan = LogicalScan('T', []);
    const exchange = LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 4, scan);
    const topn = {
      type: PlanNodeType.TOP_N,
      orderKeys: [orderKey('ID')],
      count: 10,
      offset: 0,
      children: [exchange],
      _distributed: true,
      _cardinality: 10,
    };

    const result = pass.apply(topn);
    expect(result.type).toBe(PlanNodeType.LIMIT);
    expect(result.count).toBe(10);
    expect(result.children[0].type).toBe(PlanNodeType.MERGE_EXCHANGE);
    expect(result.children[0].limit).toBe(10);
  });

  it('does not rewrite sort without exchange below', () => {
    const scan = LogicalScan('T', []);
    const sort = LogicalSort([orderKey('ID')], scan);
    sort._distributed = true;

    const result = pass.apply(sort);
    expect(result.type).toBe(PlanNodeType.SORT);
  });

  it('detects exchange nested inside filter', () => {
    const scan = LogicalScan('T', []);
    const exchange = LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 4, scan);
    const filter = {
      type: PlanNodeType.FILTER,
      condition: { kind: BoundExprKind.LITERAL, value: true },
      children: [exchange],
    };
    const sort = LogicalSort([orderKey('X')], filter);
    sort._distributed = true;

    const result = pass.apply(sort);
    expect(result.type).toBe(PlanNodeType.MERGE_EXCHANGE);
  });
});
