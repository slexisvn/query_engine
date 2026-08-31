import { describe, it, expect } from 'vitest';
import { coerceOperands, coerceGroup } from '../../src/binder/coercion.js';
import { BoundColumnRef, BoundLiteral, BoundInterval, BoundExprKind } from '../../src/binder/expression-binder.js';
import { DataType, dateToEpochDays } from '../../src/storage/data-type.js';

function col(type) {
  return BoundColumnRef('T', 'C', 0, type);
}

describe('coerceOperands', () => {
  it('leaves matching types alone', () => {
    const left = col(DataType.INT32);
    const right = BoundLiteral(5, DataType.INT32);
    expect(coerceOperands('=', left, right)).toEqual([left, right]);
  });

  it('leaves numeric widening to the runtime', () => {
    const left = col(DataType.INT32);
    const right = col(DataType.FLOAT64);
    expect(coerceOperands('=', left, right)).toEqual([left, right]);
  });

  it('does not truncate a fractional literal against an integer column', () => {
    const [, right] = coerceOperands('=', col(DataType.INT32), BoundLiteral(1.5, DataType.FLOAT64));
    expect(right.value).toBe(1.5);
  });

  it('folds a text literal into an integer column type', () => {
    const [, right] = coerceOperands('=', col(DataType.INT32), BoundLiteral('20', DataType.VARCHAR));
    expect(right.dataType).toBe(DataType.INT32);
    expect(right.value).toBe(20);
  });

  it('folds a text literal on the left-hand side', () => {
    const [left] = coerceOperands('=', BoundLiteral('20', DataType.VARCHAR), col(DataType.INT32));
    expect(left.value).toBe(20);
  });

  it('folds a date literal into epoch days', () => {
    const [, right] = coerceOperands('=', col(DataType.DATE), BoundLiteral('2020-01-01', DataType.VARCHAR));
    expect(right.dataType).toBe(DataType.DATE);
    expect(right.value).toBe(dateToEpochDays(2020, 1, 1));
  });

  it('folds a numeric literal into a text column type', () => {
    const [, right] = coerceOperands('=', col(DataType.VARCHAR), BoundLiteral(1, DataType.INT32));
    expect(right.dataType).toBe(DataType.VARCHAR);
    expect(right.value).toBe('1');
  });

  it('resolves the text side when both operands are literals', () => {
    const [left, right] = coerceOperands('=', BoundLiteral('20', DataType.VARCHAR), BoundLiteral(20, DataType.INT32));
    expect(left.value).toBe(20);
    expect(right.value).toBe(20);
  });

  it('rejects a literal that cannot be read as the target type', () => {
    expect(() => coerceOperands('=', col(DataType.INT32), BoundLiteral('abc', DataType.VARCHAR)))
      .toThrow(/Cannot interpret 'abc' as INT32/);
  });

  it('rejects two incompatible non-literal operands', () => {
    expect(() => coerceOperands('=', col(DataType.INT32), col(DataType.VARCHAR)))
      .toThrow(/not defined for INT32 and VARCHAR/);
  });

  it('allows a numeric day offset on a date in arithmetic', () => {
    const left = col(DataType.DATE);
    const right = BoundLiteral(1, DataType.INT32);
    expect(coerceOperands('+', left, right)).toEqual([left, right]);
  });

  it('still rejects a date compared against a number-free text column', () => {
    expect(() => coerceOperands('<', col(DataType.DATE), col(DataType.VARCHAR)))
      .toThrow(/not defined for DATE and VARCHAR/);
  });

  it('leaves interval operands untouched', () => {
    const left = col(DataType.DATE);
    const right = BoundInterval(1, 'DAY');
    expect(coerceOperands('+', left, right)).toEqual([left, right]);
  });

  it('leaves an untyped operand untouched', () => {
    const left = col(null);
    const right = BoundLiteral('x', DataType.VARCHAR);
    expect(coerceOperands('=', left, right)).toEqual([left, right]);
  });
});

describe('coerceGroup', () => {
  it('folds every list member against the anchor', () => {
    const group = coerceGroup('IN', col(DataType.INT32), [
      BoundLiteral('1', DataType.VARCHAR),
      BoundLiteral('2', DataType.VARCHAR),
    ]);
    expect(group.operands.map(operand => operand.value)).toEqual([1, 2]);
    expect(group.operands.every(operand => operand.dataType === DataType.INT32)).toBe(true);
  });

  it('pulls a text anchor up to the type of its operands', () => {
    const group = coerceGroup('BETWEEN', BoundLiteral('5', DataType.VARCHAR), [
      col(DataType.INT32),
      col(DataType.INT32),
    ]);
    expect(group.anchor.kind).toBe(BoundExprKind.LITERAL);
    expect(group.anchor.value).toBe(5);
  });

  it('keeps an empty operand list as is', () => {
    const anchor = col(DataType.INT32);
    expect(coerceGroup('IN', anchor, [])).toEqual({ anchor, operands: [] });
  });
});
