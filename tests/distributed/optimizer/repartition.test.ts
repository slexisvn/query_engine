import { describe, it, expect } from 'vitest';
import { partitionedScanTables, localPartitionedScanTables, shuffleKeysOf } from '../../../src/distributed/optimizer/repartition.js';
import { LogicalScan, LogicalProject, LogicalFilter, LogicalUnion, LogicalDistinct, LogicalSort, LogicalLimit } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { DataType } from '../../../src/storage/data-type.js';

const partitioned = { getTableInfo: (table) => (table === 'T' || table === 'U' ? { partitionCount: 3 } : null) };

function projection(name, index) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: name, columnIndex: index, dataType: DataType.INT32, outputName: name };
}

function scanOf(table, names) {
  return LogicalProject(names.map(projection), LogicalScan(table, names.map(name => ({ name }))));
}

describe('partitionedScanTables', () => {
  it('reports nothing without a partition map', () => {
    expect(partitionedScanTables(scanOf('T', ['A']), null).size).toBe(0);
  });

  it('reports nothing when no scanned table is partitioned', () => {
    expect(partitionedScanTables(scanOf('LOCAL', ['A']), partitioned).size).toBe(0);
  });

  it('finds a partitioned scan below intervening operators', () => {
    const plan = LogicalDistinct(LogicalProject([projection('A', 0)], LogicalFilter({ kind: BoundExprKind.LITERAL, value: true }, LogicalScan('T', [{ name: 'A' }]))));
    expect([...partitionedScanTables(plan, partitioned)]).toEqual(['T']);
  });

  it('collects every partitioned table across both sides of a binary node', () => {
    const plan = LogicalUnion(scanOf('T', ['A']), scanOf('U', ['A']), false);
    expect([...partitionedScanTables(plan, partitioned)].sort()).toEqual(['T', 'U']);
  });

  it('reports each table once and uppercases it', () => {
    const plan = LogicalUnion(scanOf('T', ['A']), scanOf('T', ['A']), false);
    expect([...partitionedScanTables(plan, partitioned)]).toEqual(['T']);
  });
});

describe('shuffleKeysOf', () => {
  it('builds a positional column ref per projected output', () => {
    const keys = shuffleKeysOf(scanOf('T', ['A', 'B']));
    expect(keys.map(k => k.columnName)).toEqual(['A', 'B']);
    expect(keys.map(k => k.columnIndex)).toEqual([0, 1]);
    expect(keys.every(k => k.kind === BoundExprKind.COLUMN_REF)).toBe(true);
  });

  it('yields no keys for a node whose outputs are not a projection list', () => {
    expect(shuffleKeysOf(LogicalScan('T', [{ name: 'A' }]))).toEqual([]);
  });
});

describe('localPartitionedScanTables', () => {
  const orderKey = { expr: projection('A', 0), direction: 'ASC' };

  it('reports the partitioned tables of a scan/filter/project subtree', () => {
    const plan = LogicalProject([projection('A', 0)], LogicalFilter({ kind: BoundExprKind.LITERAL, value: true }, LogicalScan('T', [{ name: 'A' }])));

    expect([...localPartitionedScanTables(plan, partitioned)]).toEqual(['T']);
  });

  it('treats a plain sort as row preserving', () => {
    expect([...localPartitionedScanTables(LogicalSort([orderKey], scanOf('T', ['A'])), partitioned)]).toEqual(['T']);
  });

  it('rejects a sort that truncates its input', () => {
    const sort = LogicalSort([orderKey], scanOf('T', ['A']));
    sort.limit = 3;

    expect(localPartitionedScanTables(sort, partitioned)).toBeNull();
  });

  it('rejects a subtree that drops rows per partition', () => {
    expect(localPartitionedScanTables(LogicalDistinct(scanOf('T', ['A'])), partitioned)).toBeNull();
    expect(localPartitionedScanTables(LogicalLimit(3, 0, scanOf('T', ['A'])), partitioned)).toBeNull();
  });

  it('reports an empty set for a locally evaluable but unpartitioned subtree', () => {
    expect(localPartitionedScanTables(scanOf('LOCAL', ['A']), partitioned).size).toBe(0);
  });

  it('reports nothing without a partition map', () => {
    expect(localPartitionedScanTables(scanOf('T', ['A']), null)).toBeNull();
  });
});
