import { describe, it, expect } from 'vitest';
import { exprKey, aggregateKey } from '../../src/execution/expr-key.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { DataType } from '../../src/storage/data-type.js';

function col(table, name) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name, columnIndex: 0, dataType: DataType.INT32, depth: 0, isCorrelated: false };
}

function lit(value, dataType = DataType.INT32) {
  return { kind: BoundExprKind.LITERAL, value, dataType };
}

function bin(op, left, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: DataType.INT32 };
}

describe('exprKey', () => {
  it('gives structurally equal expressions the same key', () => {
    expect(exprKey(bin('/', col('EMP', 'SAL'), lit(100))))
      .toBe(exprKey(bin('/', col('EMP', 'SAL'), lit(100))));
  });

  it('separates different operators', () => {
    expect(exprKey(bin('/', col('EMP', 'SAL'), lit(100))))
      .not.toBe(exprKey(bin('*', col('EMP', 'SAL'), lit(100))));
  });

  it('separates different table aliases', () => {
    expect(exprKey(col('A', 'X'))).not.toBe(exprKey(col('B', 'X')));
  });

  it('separates different operand order', () => {
    expect(exprKey(bin('-', col('A', 'X'), col('A', 'Y'))))
      .not.toBe(exprKey(bin('-', col('A', 'Y'), col('A', 'X'))));
  });

  it('separates a string literal from the same-looking number', () => {
    expect(exprKey(lit('1', DataType.VARCHAR))).not.toBe(exprKey(lit(1)));
  });

  it('keys CASE expressions by every branch', () => {
    const caseExpr = (elseValue) => ({
      kind: BoundExprKind.CASE,
      operand: null,
      whenClauses: [{ condition: bin('>', col('A', 'X'), lit(1)), result: lit(2) }],
      elseExpr: lit(elseValue),
      resultType: DataType.INT32,
    });
    expect(exprKey(caseExpr(3))).toBe(exprKey(caseExpr(3)));
    expect(exprKey(caseExpr(3))).not.toBe(exprKey(caseExpr(4)));
  });

  it('separates DISTINCT aggregates from plain ones', () => {
    expect(aggregateKey('SUM', true, [col('T', 'V')])).not.toBe(aggregateKey('SUM', false, [col('T', 'V')]));
  });

  it('matches the aggregate node key built from parts', () => {
    const agg = { kind: BoundExprKind.AGGREGATE, name: 'SUM', args: [col('T', 'V')], distinct: false, resultType: DataType.INT32 };
    expect(exprKey(agg)).toBe(aggregateKey('SUM', false, [col('T', 'V')]));
  });

  it('is case insensitive on aggregate names', () => {
    expect(aggregateKey('sum', false, [])).toBe(aggregateKey('SUM', false, []));
  });

  it('separates window frames', () => {
    const win = (frame) => ({
      kind: BoundExprKind.WINDOW,
      name: 'SUM',
      args: [col('T', 'V')],
      partitionBy: [],
      orderBy: [],
      frame,
      resultType: DataType.INT32,
    });
    const rows = { mode: 'ROWS', start: { type: 'UNBOUNDED_PRECEDING', offset: null }, end: { type: 'CURRENT_ROW', offset: null } };
    const bounded = { mode: 'ROWS', start: { type: 'PRECEDING', offset: 1 }, end: { type: 'CURRENT_ROW', offset: null } };
    expect(exprKey(win(rows))).not.toBe(exprKey(win(bounded)));
    expect(exprKey(win(null))).not.toBe(exprKey(win(rows)));
  });

  it('falls back to a structural key for descriptors without a known kind', () => {
    const descriptor = { kind: 'SomethingElse', name: 'X' };
    expect(exprKey(descriptor)).toBe(exprKey(descriptor));
    expect(exprKey(descriptor)).not.toBe(exprKey({ kind: 'SomethingElse', name: 'Y' }));
  });
});
