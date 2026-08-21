import { describe, it, expect } from 'vitest';
import { columnKey, isUniqueOnKeys, producesDistinctRows } from '../../src/optimizer/unique-keys.js';
import {
  LogicalScan,
  LogicalProject,
  LogicalFilter,
  LogicalAggregate,
  LogicalDistinct,
  LogicalJoin,
  LogicalLimit,
  LogicalSort,
  JoinType,
} from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function colRef(table, column, outputName) {
  const ref = { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column };
  return outputName ? { ...ref, outputName } : ref;
}

const catalog = {
  getTable(name) {
    if (name.toLowerCase() === 'users') return { primaryKey: ['id'] };
    if (name.toLowerCase() === 'pairs') return { primaryKey: ['a', 'b'] };
    return null;
  },
};

function keys(...names) {
  return new Set(names);
}

describe('columnKey', () => {
  it('upper-cases both parts', () => {
    expect(columnKey('u', 'id')).toBe('U.ID');
  });

  it('keeps an empty alias distinguishable', () => {
    expect(columnKey(null, 'id')).toBe('.ID');
  });
});

describe('isUniqueOnKeys', () => {
  it('rejects an empty key set', () => {
    expect(isUniqueOnKeys(LogicalScan('users', [], 'u'), keys(), catalog)).toBe(false);
  });

  it('accepts a scan whose primary key is covered', () => {
    expect(isUniqueOnKeys(LogicalScan('users', [], 'u'), keys('U.ID'), catalog)).toBe(true);
  });

  it('accepts a scan whose primary key is a subset of the join keys', () => {
    expect(isUniqueOnKeys(LogicalScan('users', [], 'u'), keys('U.ID', 'U.NAME'), catalog)).toBe(true);
  });

  it('rejects a scan whose composite key is only partly covered', () => {
    expect(isUniqueOnKeys(LogicalScan('pairs', [], 'p'), keys('P.A'), catalog)).toBe(false);
  });

  it('accepts a scan whose composite key is fully covered', () => {
    expect(isUniqueOnKeys(LogicalScan('pairs', [], 'p'), keys('P.A', 'P.B'), catalog)).toBe(true);
  });

  it('rejects a scan with no declared key', () => {
    expect(isUniqueOnKeys(LogicalScan('orders', [], 'o'), keys('O.ID'), catalog)).toBe(false);
  });

  it('rejects a scan when no catalog is available', () => {
    expect(isUniqueOnKeys(LogicalScan('users', [], 'u'), keys('U.ID'), null)).toBe(false);
  });

  it('accepts an aggregate grouped on the key', () => {
    const plan = LogicalAggregate([colRef('g', 'k')], [], LogicalScan('orders', [], 'g'));
    expect(isUniqueOnKeys(plan, keys('G.K'), null)).toBe(true);
  });

  it('rejects an aggregate grouped on a different column', () => {
    const plan = LogicalAggregate([colRef('g', 'other')], [], LogicalScan('orders', [], 'g'));
    expect(isUniqueOnKeys(plan, keys('G.K'), null)).toBe(false);
  });

  it('accepts an ungrouped aggregate', () => {
    const plan = LogicalAggregate([], [], LogicalScan('orders', [], 'g'));
    expect(isUniqueOnKeys(plan, keys('G.K'), null)).toBe(true);
  });

  it('sees through a filter', () => {
    const plan = LogicalFilter(null, LogicalScan('users', [], 'u'));
    expect(isUniqueOnKeys(plan, keys('U.ID'), catalog)).toBe(true);
  });

  it('translates keys through a pass-through projection', () => {
    const plan = LogicalProject([colRef('u', 'id')], LogicalScan('users', [], 'u'));
    expect(isUniqueOnKeys(plan, keys('.ID'), catalog)).toBe(true);
  });

  it('translates keys through an aliased projection', () => {
    const plan = LogicalProject([colRef('u', 'id')], LogicalScan('users', [], 'u'), 'sub');
    expect(isUniqueOnKeys(plan, keys('SUB.ID'), catalog)).toBe(true);
  });

  it('rejects a projection that does not expose the key', () => {
    const plan = LogicalProject([colRef('u', 'name')], LogicalScan('users', [], 'u'), 'sub');
    expect(isUniqueOnKeys(plan, keys('SUB.ID'), catalog)).toBe(false);
  });

  it('accepts a distinct over exactly the key columns', () => {
    const plan = LogicalDistinct(LogicalProject([colRef('t', 'k')], LogicalScan('orders', [], 't')));
    expect(isUniqueOnKeys(plan, keys('T.K'), null)).toBe(true);
  });

  it('rejects a distinct that carries extra columns', () => {
    const plan = LogicalDistinct(LogicalProject([colRef('t', 'k'), colRef('t', 'v')], LogicalScan('orders', [], 't')));
    expect(isUniqueOnKeys(plan, keys('T.K'), null)).toBe(false);
  });

  it('rejects a join', () => {
    const plan = LogicalJoin(JoinType.INNER, null, LogicalScan('users', [], 'u'), LogicalScan('orders', [], 'o'));
    expect(isUniqueOnKeys(plan, keys('U.ID'), catalog)).toBe(false);
  });
});

describe('producesDistinctRows', () => {
  it('accepts an aggregate because it emits one row per group', () => {
    const plan = LogicalAggregate([colRef('u', 'city')], [], LogicalScan('users', [], 'u'));
    expect(producesDistinctRows(plan, catalog)).toBe(true);
  });

  it('accepts a scalar aggregate because it emits a single row', () => {
    const plan = LogicalAggregate([], [], LogicalScan('users', [], 'u'));
    expect(producesDistinctRows(plan, catalog)).toBe(true);
  });

  it('accepts a distinct node', () => {
    expect(producesDistinctRows(LogicalDistinct(LogicalScan('users', [], 'u')), catalog)).toBe(true);
  });

  it('accepts a projection of every group key of an aggregate', () => {
    const aggregate = LogicalAggregate([colRef('u', 'city')], [], LogicalScan('users', [], 'u'));
    const plan = LogicalProject([colRef('u', 'city', 'city')], aggregate);
    expect(producesDistinctRows(plan, catalog)).toBe(true);
  });

  it('rejects a projection that drops a group key of an aggregate', () => {
    const aggregate = LogicalAggregate([colRef('u', 'city'), colRef('u', 'year')], [], LogicalScan('users', [], 'u'));
    const plan = LogicalProject([colRef('u', 'city', 'city')], aggregate);
    expect(producesDistinctRows(plan, catalog)).toBe(false);
  });

  it('accepts a projection of a primary key', () => {
    const plan = LogicalProject([colRef('u', 'id', 'id')], LogicalScan('users', [], 'u'));
    expect(producesDistinctRows(plan, catalog)).toBe(true);
  });

  it('rejects a projection of a non-key column', () => {
    const plan = LogicalProject([colRef('u', 'city', 'city')], LogicalScan('users', [], 'u'));
    expect(producesDistinctRows(plan, catalog)).toBe(false);
  });

  it('sees through a filter, which cannot create duplicates', () => {
    const aggregate = LogicalAggregate([colRef('u', 'city')], [], LogicalScan('users', [], 'u'));
    expect(producesDistinctRows(LogicalFilter(null, aggregate), catalog)).toBe(true);
  });

  it('sees through a limit, which only drops rows', () => {
    const aggregate = LogicalAggregate([colRef('u', 'city')], [], LogicalScan('users', [], 'u'));
    expect(producesDistinctRows(LogicalLimit(5, 0, aggregate), catalog)).toBe(true);
  });

  it('sees through a sort, which only reorders rows', () => {
    const aggregate = LogicalAggregate([colRef('u', 'city')], [], LogicalScan('users', [], 'u'));
    const sorted = LogicalSort([{ expr: colRef('u', 'city'), direction: 'ASC' }], aggregate);
    expect(producesDistinctRows(sorted, catalog)).toBe(true);
  });

  it('rejects a bare scan', () => {
    expect(producesDistinctRows(LogicalScan('users', [], 'u'), catalog)).toBe(false);
  });

  it('rejects a join', () => {
    const plan = LogicalJoin(JoinType.INNER, null, LogicalScan('users', [], 'u'), LogicalScan('orders', [], 'o'));
    expect(producesDistinctRows(plan, catalog)).toBe(false);
  });
});
