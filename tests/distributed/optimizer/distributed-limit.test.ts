import { describe, it, expect } from 'vitest';
import { DistributedLimitPass } from '../../../src/distributed/optimizer/distributed-limit.js';
import { PlanNodeType, LogicalScan, LogicalProject, LogicalFilter, LogicalLimit, LogicalTopN, LogicalSort, LogicalDistinct, LogicalExchange } from '../../../src/planner/logical-plan.js';
import { ExchangeType } from '../../../src/distributed/planner/fragment.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { DataType } from '../../../src/storage/data-type.js';

const partitioned = { getTableInfo: (table) => (table === 'T' ? { partitionCount: 3 } : null) };

function projection(name, index) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: name, columnIndex: index, dataType: DataType.INT32, outputName: name };
}

function input(table = 'T', names = ['A']) {
  return LogicalProject(names.map(projection), LogicalScan(table, names.map(name => ({ name }))));
}

const orderKey = { expr: projection('A', 0), direction: 'ASC' };

function distributed(node) {
  node._distributed = true;
  return node;
}

describe('DistributedLimitPass', () => {
  const pass = new DistributedLimitPass(partitioned);

  it('leaves non-distributed plans alone', () => {
    const plan = LogicalLimit(5, 0, input());

    expect(pass.apply(plan)).toBe(plan);
  });

  it('leaves a limit over an unpartitioned table alone', () => {
    const plan = distributed(LogicalLimit(5, 0, input('LOCAL')));

    expect(pass.apply(plan)).toBe(plan);
  });

  describe('LIMIT', () => {
    it('takes count plus offset per partition and applies the real window once', () => {
      const result = pass.apply(distributed(LogicalLimit(5, 3, input())));

      expect(result.type).toBe(PlanNodeType.LIMIT);
      expect(result.count).toBe(5);
      expect(result.offset).toBe(3);

      const exchange = result.children[0];
      expect(exchange.type).toBe(PlanNodeType.EXCHANGE);
      expect(exchange.exchangeType).toBe(ExchangeType.HASH_SHUFFLE);
      expect(exchange.children[0].type).toBe(PlanNodeType.LIMIT);
      expect(exchange.children[0].count).toBe(8);
      expect(exchange.children[0].offset).toBe(0);
    });

    it('keeps a zero limit at zero', () => {
      const result = pass.apply(distributed(LogicalLimit(0, 0, input())));

      expect(result.count).toBe(0);
      expect(result.children[0].children[0].count).toBe(0);
    });

    it('reaches through multiset-preserving operators to find the partitioned scan', () => {
      const filtered = LogicalProject([projection('A', 0)], LogicalFilter({ kind: BoundExprKind.LITERAL, value: true }, LogicalScan('T', [{ name: 'A' }])));

      const result = pass.apply(distributed(LogicalLimit(5, 0, filtered)));
      expect(result.children[0].type).toBe(PlanNodeType.EXCHANGE);
    });

    it('leaves a limit whose input already drops rows alone', () => {
      const plan = distributed(LogicalLimit(5, 0, LogicalDistinct(input())));

      expect(pass.apply(plan).children[0].type).toBe(PlanNodeType.DISTINCT);
    });

    it('leaves a limit whose input already carries an exchange alone', () => {
      const plan = distributed(LogicalLimit(5, 0, LogicalExchange(ExchangeType.HASH_SHUFFLE, [], 0, input())));

      expect(pass.apply(plan).children[0].type).toBe(PlanNodeType.EXCHANGE);
      expect(pass.apply(plan).children[0].children[0].type).toBe(PlanNodeType.PROJECT);
    });

    it('leaves a limit over a sort that already truncates alone', () => {
      const sort = LogicalSort([orderKey], input());
      sort.limit = 2;

      expect(pass.apply(distributed(LogicalLimit(5, 0, sort))).children[0].type).toBe(PlanNodeType.SORT);
    });

    it('treats a plain sort as row preserving and still globalises', () => {
      const plan = distributed(LogicalLimit(5, 0, LogicalSort([orderKey], input())));

      expect(pass.apply(plan).children[0].type).toBe(PlanNodeType.EXCHANGE);
    });
  });

  describe('TopN', () => {
    it('fetches count plus offset per partition and re-ranks globally', () => {
      const result = pass.apply(distributed(LogicalTopN([orderKey], 7, 4, input())));

      expect(result.type).toBe(PlanNodeType.TOP_N);
      expect(result.count).toBe(7);
      expect(result.offset).toBe(4);
      expect(result.orderKeys).toHaveLength(1);

      const local = result.children[0].children[0];
      expect(local.type).toBe(PlanNodeType.TOP_N);
      expect(local.count).toBe(11);
      expect(local.offset).toBe(0);
      expect(local.orderKeys).toEqual(result.orderKeys);
    });

    it('shuffles on every output column of the input', () => {
      const result = pass.apply(distributed(LogicalTopN([orderKey], 3, 0, input('T', ['A', 'B']))));

      const keys = result.children[0].partitionKeys;
      expect(keys.map(k => k.columnName)).toEqual(['A', 'B']);
    });

    it('rewrites each node exactly once', () => {
      const result = pass.apply(distributed(LogicalTopN([orderKey], 3, 0, input())));

      const count = (node, type) =>
        (node.type === type ? 1 : 0) + (node.children || []).reduce((n, c) => n + count(c, type), 0);
      expect(count(result, PlanNodeType.TOP_N)).toBe(2);
      expect(count(result, PlanNodeType.EXCHANGE)).toBe(1);
    });
  });
});
