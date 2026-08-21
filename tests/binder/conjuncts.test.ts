import { describe, it, expect } from 'vitest';
import { splitConjuncts, combineConjuncts } from '../../src/binder/conjuncts.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function colRef(tableAlias, columnName) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias, columnName };
}

function lit(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function eq(left, right) {
  return { kind: BoundExprKind.BINARY, op: '=', left, right };
}

function gt(left, right) {
  return { kind: BoundExprKind.BINARY, op: '>', left, right };
}

function and(left, right, op = 'AND') {
  return { kind: BoundExprKind.BINARY, op, left, right };
}

function or(left, right) {
  return { kind: BoundExprKind.BINARY, op: 'OR', left, right };
}

describe('splitConjuncts', () => {
  it('returns empty for null', () => {
    expect(splitConjuncts(null)).toEqual([]);
  });

  it('returns single predicate as-is', () => {
    const pred = eq(colRef('L', 'ID'), lit(1));
    expect(splitConjuncts(pred)).toEqual([pred]);
  });

  it('splits AND into flat list', () => {
    const p1 = eq(colRef('L', 'ID'), lit(1));
    const p2 = gt(colRef('L', 'NAME'), lit('a'));
    expect(splitConjuncts(and(p1, p2))).toEqual([p1, p2]);
  });

  it('recursively flattens nested ANDs', () => {
    const p1 = eq(colRef('L', 'ID'), lit(1));
    const p2 = eq(colRef('L', 'ID'), lit(2));
    const p3 = eq(colRef('L', 'ID'), lit(3));
    expect(splitConjuncts(and(and(p1, p2), p3))).toEqual([p1, p2, p3]);
  });

  it('does not split OR', () => {
    const expr = or(eq(colRef('L', 'ID'), lit(1)), eq(colRef('L', 'ID'), lit(2)));
    expect(splitConjuncts(expr)).toEqual([expr]);
  });

  it('splits a lowercase AND the same way', () => {
    const p1 = eq(colRef('L', 'ID'), lit(1));
    const p2 = eq(colRef('L', 'ID'), lit(2));
    expect(splitConjuncts(and(p1, p2, 'and'))).toEqual([p1, p2]);
  });
});

describe('combineConjuncts', () => {
  it('returns null for an empty list', () => {
    expect(combineConjuncts([])).toBeNull();
  });

  it('returns a lone predicate untouched', () => {
    const pred = eq(colRef('L', 'ID'), lit(1));
    expect(combineConjuncts([pred])).toBe(pred);
  });

  it('round-trips through splitConjuncts', () => {
    const preds = [1, 2, 3, 4].map(v => eq(colRef('L', 'ID'), lit(v)));
    expect(splitConjuncts(combineConjuncts(preds))).toEqual(preds);
  });

  it('produces a boolean-typed conjunction', () => {
    const preds = [1, 2].map(v => eq(colRef('L', 'ID'), lit(v)));
    const combined = combineConjuncts(preds);
    expect(combined.kind).toBe(BoundExprKind.BINARY);
    expect(combined.op).toBe('AND');
    expect(combined.resultType).toBe('BOOLEAN');
  });
});
