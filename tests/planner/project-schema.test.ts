import { describe, it, expect } from 'vitest';
import { projectedColumnName, projectedColumnAlias } from '../../src/planner/project-schema.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function colRef(table, column, extra = {}) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column, ...extra };
}

describe('projectedColumnName', () => {
  it('prefers the explicit output name', () => {
    expect(projectedColumnName(colRef('T', 'A', { outputName: 'X', alias: 'Y' }), 0)).toBe('X');
  });

  it('falls back through alias, name and column name', () => {
    expect(projectedColumnName(colRef('T', 'A', { alias: 'Y' }), 0)).toBe('Y');
    expect(projectedColumnName({ kind: BoundExprKind.LITERAL, name: 'N' }, 0)).toBe('N');
    expect(projectedColumnName(colRef('T', 'A'), 0)).toBe('A');
  });

  it('falls back to a positional name when the expression is unnamed', () => {
    expect(projectedColumnName({ kind: BoundExprKind.LITERAL, value: 1 }, 3)).toBe('col3');
  });
});

describe('projectedColumnAlias', () => {
  it('uses the project output alias when there is one', () => {
    expect(projectedColumnAlias(colRef('T', 'A'), 'A', 'X')).toBe('X');
  });

  it('passes the source alias through for a plain column reference', () => {
    expect(projectedColumnAlias(colRef('T', 'A'), 'A', '')).toBe('T');
  });

  it('drops the source alias once the column is renamed', () => {
    expect(projectedColumnAlias(colRef('T', 'A'), 'B', '')).toBe('');
  });

  it('matches the column name case-insensitively', () => {
    expect(projectedColumnAlias(colRef('T', 'a'), 'A', '')).toBe('T');
  });

  it('reports no alias for a computed expression', () => {
    expect(projectedColumnAlias({ kind: BoundExprKind.BINARY, op: '+' }, 'col0', '')).toBe('');
  });
});
