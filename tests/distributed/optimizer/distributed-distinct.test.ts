import { describe, it, expect } from 'vitest';
import { DistributedDistinctPass } from '../../../src/distributed/optimizer/distributed-distinct.js';
import { PlanNodeType, LogicalScan, LogicalProject, LogicalDistinct, LogicalFilter } from '../../../src/planner/logical-plan.js';
import { ExchangeType } from '../../../src/distributed/planner/fragment.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { DataType } from '../../../src/storage/data-type.js';

const partitioned = { getTableInfo: (table) => (table === 'T' ? { partitionCount: 3 } : null) };

function projection(name, index) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: name, columnIndex: index, dataType: DataType.INT32, outputName: name };
}

function distinctOver(table, names) {
  const scan = LogicalScan(table, names.map(name => ({ name })));
  return LogicalDistinct(LogicalProject(names.map(projection), scan));
}

describe('DistributedDistinctPass', () => {
  const pass = new DistributedDistinctPass(partitioned);

  it('leaves non-distributed plans alone', () => {
    const plan = distinctOver('T', ['A']);

    const result = pass.apply(plan);
    expect(result).toBe(plan);
  });

  it('splits distinct into local dedup, shuffle and final dedup', () => {
    const plan = distinctOver('T', ['A']);
    plan._distributed = true;

    const result = pass.apply(plan);
    expect(result.type).toBe(PlanNodeType.DISTINCT);
    expect(result.children[0].type).toBe(PlanNodeType.EXCHANGE);
    expect(result.children[0].exchangeType).toBe(ExchangeType.HASH_SHUFFLE);
    expect(result.children[0].children[0].type).toBe(PlanNodeType.DISTINCT);
    expect(result.children[0].children[0].children[0].type).toBe(PlanNodeType.PROJECT);
  });

  it('shuffles on every output column of the distinct', () => {
    const plan = distinctOver('T', ['A', 'B']);
    plan._distributed = true;

    const keys = pass.apply(plan).children[0].partitionKeys;
    expect(keys.map(k => k.columnName)).toEqual(['A', 'B']);
    expect(keys.map(k => k.columnIndex)).toEqual([0, 1]);
  });

  it('leaves distinct over an unpartitioned table alone', () => {
    const plan = distinctOver('LOCAL', ['A']);
    plan._distributed = true;

    const result = pass.apply(plan);
    expect(result.children[0].type).toBe(PlanNodeType.PROJECT);
  });

  it('finds the partitioned scan below intervening operators', () => {
    const scan = LogicalScan('T', [{ name: 'A' }]);
    const filter = LogicalFilter({ kind: BoundExprKind.LITERAL, value: true }, scan);
    const plan = LogicalDistinct(LogicalProject([projection('A', 0)], filter));
    plan._distributed = true;

    const result = pass.apply(plan);
    expect(result.children[0].type).toBe(PlanNodeType.EXCHANGE);
  });

  it('carries the cardinality estimate onto the rewritten nodes', () => {
    const plan = distinctOver('T', ['A']);
    plan._distributed = true;
    plan._cardinality = 500;

    const result = pass.apply(plan);
    expect(result._cardinality).toBe(500);
    expect(result.children[0]._cardinality).toBe(500);
    expect(result.children[0].children[0]._cardinality).toBe(500);
  });

  it('rewrites each distinct exactly once', () => {
    const plan = distinctOver('T', ['A']);
    plan._distributed = true;

    const once = pass.apply(plan);
    const distinctCount = (node) =>
      (node.type === PlanNodeType.DISTINCT ? 1 : 0) + (node.children || []).reduce((n, c) => n + distinctCount(c), 0);
    expect(distinctCount(once)).toBe(2);
  });
});
