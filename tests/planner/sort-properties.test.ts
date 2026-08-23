import { describe, it, expect } from 'vitest';
import {
  columnKeyOf,
  extractEquiJoinKeys,
  inferSortOrder,
  isPureEquiJoin,
  isSortedBy,
  isSortedByPrefix,
  satisfiesOrder,
  sortDirectionOf,
  sortKeyMatches,
} from '../../src/planner/sort-properties.js';
import { PlanNodeType, LogicalScan, LogicalSort, LogicalFilter } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

describe('columnKeyOf', () => {
  it('qualifies a column reference with its relation name', () => {
    expect(columnKeyOf(colRef('a', 'id'))).toBe('A.ID');
  });

  it('marks an unqualified reference with an empty relation name', () => {
    expect(columnKeyOf(colRef(null, 'id'))).toBe('.ID');
  });

  it('has no key for an expression that is not a bare column', () => {
    expect(columnKeyOf(bin(colRef('a', 'id'), '+', colRef('a', 'val')))).toBeNull();
  });
});

describe('sortKeyMatches', () => {
  it('matches a key against itself', () => {
    expect(sortKeyMatches('A.ID', 'A.ID')).toBe(true);
  });

  it('does not match the same column name on two different relations', () => {
    expect(sortKeyMatches('A.ID', 'B.ID')).toBe(false);
  });

  it('does not match different columns of one relation', () => {
    expect(sortKeyMatches('A.ID', 'A.VAL')).toBe(false);
  });

  it('falls back to the column name when the recorded order is unqualified', () => {
    expect(sortKeyMatches('.ID', 'A.ID')).toBe(true);
  });

  it('falls back to the column name when the requirement is unqualified', () => {
    expect(sortKeyMatches('A.ID', '.ID')).toBe(true);
  });

  it('treats a missing key on either side as no match', () => {
    expect(sortKeyMatches(null, 'A.ID')).toBe(false);
    expect(sortKeyMatches('A.ID', null)).toBe(false);
  });

  it('reads the key out of a directional entry', () => {
    expect(sortKeyMatches({ key: 'A.ID', direction: 'DESC' }, 'A.ID')).toBe(true);
  });
});

describe('sortDirectionOf', () => {
  it('reports the recorded direction in upper case', () => {
    expect(sortDirectionOf({ key: 'A.ID', direction: 'desc' })).toBe('DESC');
  });

  it('assumes ascending for a bare key', () => {
    expect(sortDirectionOf('A.ID')).toBe('ASC');
  });
});

describe('isSortedBy', () => {
  it('accepts an order that leads with the required keys', () => {
    expect(isSortedBy(['A.ID', 'A.VAL'], ['A.ID'])).toBe(true);
  });

  it('rejects an order whose leading key belongs to another relation', () => {
    expect(isSortedBy(['A.ID'], ['B.ID'])).toBe(false);
  });

  it('rejects an order that has the required keys in the wrong position', () => {
    expect(isSortedBy(['A.VAL', 'A.ID'], ['A.ID'])).toBe(false);
  });

  it('rejects an unknown or empty order', () => {
    expect(isSortedBy(undefined, ['A.ID'])).toBe(false);
    expect(isSortedBy([], ['A.ID'])).toBe(false);
  });
});

describe('isSortedByPrefix', () => {
  it('accepts required keys covered by the leading positions in any order', () => {
    expect(isSortedByPrefix(['A.VAL', 'A.ID'], ['A.ID', 'A.VAL'])).toBe(true);
  });

  it('rejects required keys that reach beyond the recorded order', () => {
    expect(isSortedByPrefix(['A.ID'], ['A.ID', 'A.VAL'])).toBe(false);
  });

  it('rejects a same-named column from another relation', () => {
    expect(isSortedByPrefix(['A.ID'], ['B.ID'])).toBe(false);
  });
});

describe('extractEquiJoinKeys', () => {
  it('pairs each side of an equality on bare columns', () => {
    const keys = extractEquiJoinKeys(bin(colRef('a', 'id'), '=', colRef('b', 'fk')));
    expect(keys).toEqual({ leftKeys: ['A.ID'], rightKeys: ['B.FK'] });
  });

  it('collects every conjunct of a composite key', () => {
    const condition = {
      kind: BoundExprKind.BINARY,
      op: 'AND',
      left: bin(colRef('a', 'id'), '=', colRef('b', 'fk')),
      right: bin(colRef('a', 'val'), '=', colRef('b', 'val')),
      resultType: 'BOOLEAN',
    };
    expect(extractEquiJoinKeys(condition).leftKeys).toEqual(['A.ID', 'A.VAL']);
  });

  it('skips a conjunct that is not an equality between columns', () => {
    const condition = {
      kind: BoundExprKind.BINARY,
      op: 'AND',
      left: bin(colRef('a', 'id'), '=', colRef('b', 'fk')),
      right: bin(colRef('a', 'val'), '>', colRef('b', 'val')),
      resultType: 'BOOLEAN',
    };
    expect(extractEquiJoinKeys(condition).leftKeys).toEqual(['A.ID']);
  });
});

describe('isPureEquiJoin', () => {
  it('accepts a condition made only of column equalities', () => {
    expect(isPureEquiJoin(bin(colRef('a', 'id'), '=', colRef('b', 'fk')))).toBe(true);
  });

  it('rejects a condition carrying a non-equality conjunct', () => {
    const condition = {
      kind: BoundExprKind.BINARY,
      op: 'AND',
      left: bin(colRef('a', 'id'), '=', colRef('b', 'fk')),
      right: bin(colRef('a', 'val'), '>', colRef('b', 'val')),
      resultType: 'BOOLEAN',
    };
    expect(isPureEquiJoin(condition)).toBe(false);
  });

  it('rejects a missing condition', () => {
    expect(isPureEquiJoin(null)).toBe(false);
  });
});

describe('inferSortOrder', () => {
  it('reads the order a Sort node establishes', () => {
    const sort = LogicalSort(
      [{ expr: colRef('a', 'id'), direction: 'desc' }],
      LogicalScan('a', ['id'], 'a'),
    );
    expect(inferSortOrder(sort)).toEqual([{ key: 'A.ID', direction: 'DESC' }]);
  });

  it('drops a sort key that is not a bare column', () => {
    const sort = LogicalSort(
      [{ expr: bin(colRef('a', 'id'), '+', colRef('a', 'id')), direction: 'ASC' }],
      LogicalScan('a', ['id'], 'a'),
    );
    expect(inferSortOrder(sort)).toEqual([]);
  });

  it('passes a child order through a filter unchanged', () => {
    const scan = LogicalScan('a', ['id'], 'a');
    scan._sortedBy = ['A.ID'];
    expect(inferSortOrder(LogicalFilter(null, scan))).toEqual(['A.ID']);
  });

  it('claims no order for a node type that establishes none', () => {
    const scan = LogicalScan('a', ['id'], 'a');
    expect(scan.type).toBe(PlanNodeType.SCAN);
    expect(inferSortOrder(scan)).toEqual([]);
  });
});

describe('satisfiesOrder', () => {
  const asc = (table, column) => ({ expr: colRef(table, column), direction: 'ASC' });
  const desc = (table, column) => ({ expr: colRef(table, column), direction: 'DESC' });

  it('accepts a provided order that matches the required keys and directions', () => {
    const provided = [{ key: 'A.ID', direction: 'ASC' }, { key: 'A.NAME', direction: 'ASC' }];
    expect(satisfiesOrder(provided, [asc('a', 'id'), asc('a', 'name')])).toBe(true);
  });

  it('accepts a provided order longer than required because the prefix decides', () => {
    const provided = [{ key: 'A.ID', direction: 'ASC' }, { key: 'A.NAME', direction: 'ASC' }];
    expect(satisfiesOrder(provided, [asc('a', 'id')])).toBe(true);
  });

  it('rejects a provided order shorter than required', () => {
    const provided = [{ key: 'A.ID', direction: 'ASC' }];
    expect(satisfiesOrder(provided, [asc('a', 'id'), asc('a', 'name')])).toBe(false);
  });

  it('rejects a matching key whose direction differs', () => {
    const provided = [{ key: 'A.ID', direction: 'ASC' }];
    expect(satisfiesOrder(provided, [desc('a', 'id')])).toBe(false);
  });

  it('rejects keys that match only out of position', () => {
    const provided = [{ key: 'A.NAME', direction: 'ASC' }, { key: 'A.ID', direction: 'ASC' }];
    expect(satisfiesOrder(provided, [asc('a', 'id')])).toBe(false);
  });

  it('treats a missing direction on the required key as ASC', () => {
    const provided = [{ key: 'A.ID', direction: 'ASC' }];
    expect(satisfiesOrder(provided, [{ expr: colRef('a', 'id') }])).toBe(true);
  });

  it('rejects a required key that is not a bare column', () => {
    const provided = [{ key: 'A.ID', direction: 'ASC' }];
    const computed = { expr: bin(colRef('a', 'id'), '+', colRef('a', 'id')), direction: 'ASC' };
    expect(satisfiesOrder(provided, [computed])).toBe(false);
  });

  it('rejects when nothing is provided or nothing is required', () => {
    expect(satisfiesOrder(undefined, [asc('a', 'id')])).toBe(false);
    expect(satisfiesOrder([], [asc('a', 'id')])).toBe(false);
    expect(satisfiesOrder([{ key: 'A.ID', direction: 'ASC' }], [])).toBe(false);
  });
});
