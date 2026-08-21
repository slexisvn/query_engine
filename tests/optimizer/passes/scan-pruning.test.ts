import { describe, it, expect } from 'vitest';
import { ScanPruning } from '../../../src/optimizer/passes/scan-pruning.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
  LogicalProject,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { DataType } from '../../../src/storage/data-type.js';

const pass = new ScanPruning();

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col, columnIndex: 0, dataType: DataType.INT32, depth: 0, isCorrelated: false };
}

function lit(value) {
  return { kind: BoundExprKind.LITERAL, value, dataType: DataType.INT32 };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: DataType.BOOLEAN };
}

function scan(name) {
  return LogicalScan(name, [{ name: 'ID', dataType: DataType.INT32 }], name);
}

describe('ScanPruning', () => {
  it('records the filter sitting directly above a scan on the scan node', () => {
    const condition = bin(colRef('T', 'ID'), '>', lit(10));
    const plan = LogicalFilter(condition, scan('T'));

    const result = pass.apply(plan);

    expect(result.type).toBe(PlanNodeType.FILTER);
    expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    expect(result.children[0].pruningFilter).toBe(condition);
  });

  it('leaves the filter in place so surviving rows are still evaluated', () => {
    const condition = bin(colRef('T', 'ID'), '>', lit(10));

    const result = pass.apply(LogicalFilter(condition, scan('T')));

    expect(result.condition).toBe(condition);
  });

  it('does not mutate the scan node it was given', () => {
    const original = scan('T');
    const plan = LogicalFilter(bin(colRef('T', 'ID'), '>', lit(10)), original);

    pass.apply(plan);

    expect(original.pruningFilter).toBeUndefined();
  });

  it('leaves a scan with no filter above it untouched', () => {
    const result = pass.apply(scan('T'));

    expect(result.type).toBe(PlanNodeType.SCAN);
    expect(result.pruningFilter).toBeUndefined();
  });

  it('leaves a scan separated from the filter by another operator untouched', () => {
    const plan = LogicalFilter(
      bin(colRef('T', 'ID'), '>', lit(10)),
      LogicalProject([colRef('T', 'ID')], scan('T')),
    );

    const result = pass.apply(plan);

    expect(result.children[0].children[0].pruningFilter).toBeUndefined();
  });

  it('records the filter on scans nested under a join', () => {
    const leftCondition = bin(colRef('L', 'ID'), '>', lit(10));
    const rightCondition = bin(colRef('R', 'ID'), '<', lit(99));
    const plan = LogicalJoin(
      JoinType.INNER,
      bin(colRef('L', 'ID'), '=', colRef('R', 'ID')),
      LogicalFilter(leftCondition, scan('L')),
      LogicalFilter(rightCondition, scan('R')),
    );

    const result = pass.apply(plan);

    expect(result.children[0].children[0].pruningFilter).toBe(leftCondition);
    expect(result.children[1].children[0].pruningFilter).toBe(rightCondition);
  });

  it('leaves a filter with no condition alone', () => {
    const plan = LogicalFilter(null, scan('T'));

    const result = pass.apply(plan);

    expect(result.children[0].pruningFilter).toBeUndefined();
  });
});
