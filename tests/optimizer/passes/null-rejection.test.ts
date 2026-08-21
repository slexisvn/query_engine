import { describe, it, expect } from 'vitest';
import { isNullRejecting } from '../../../src/optimizer/passes/null-rejection.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const NULL_SIDE = { aliases: new Set(['R']), columns: new Set(['RV']) };

const col = (table, name) => ({ kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name });
const lit = (value) => ({ kind: BoundExprKind.LITERAL, value });
const bin = (left, op, right) => ({ kind: BoundExprKind.BINARY, op, left, right });
const isNull = (expr, negated = false) => ({ kind: BoundExprKind.IS_NULL, expr, negated });
const fn = (name, ...args) => ({ kind: BoundExprKind.FUNCTION, name, args });
const caseWhen = (condition, result, elseExpr) => ({
  kind: BoundExprKind.CASE,
  whenClauses: [{ condition, result }],
  elseExpr,
});

describe('null rejection analysis', () => {
  describe('predicates that reject NULLs', () => {
    it('treats a comparison against a nulled column as rejecting', () => {
      expect(isNullRejecting(bin(col('R', 'RV'), '=', lit('x')), NULL_SIDE)).toBe(true);
    });

    it('treats every comparison operator alike', () => {
      for (const op of ['=', '<>', '<', '>', '<=', '>=']) {
        expect(isNullRejecting(bin(col('R', 'RV'), op, lit(1)), NULL_SIDE)).toBe(true);
      }
    });

    it('treats IS NOT NULL on a nulled column as rejecting', () => {
      expect(isNullRejecting(isNull(col('R', 'RV'), true), NULL_SIDE)).toBe(true);
    });

    it('treats an unqualified reference to a nulled output column as rejecting', () => {
      expect(isNullRejecting(bin(col('', 'RV'), '=', lit(1)), NULL_SIDE)).toBe(true);
    });

    it('rejects when either side of an AND rejects', () => {
      const pred = bin(bin(col('R', 'RV'), '=', lit(1)), 'AND', bin(col('L', 'LV'), '=', lit(2)));
      expect(isNullRejecting(pred, NULL_SIDE)).toBe(true);
    });
  });

  describe('predicates that tolerate NULLs', () => {
    it('does not reject when COALESCE supplies a value for the nulled column', () => {
      expect(isNullRejecting(bin(fn('COALESCE', col('R', 'RV'), lit(0)), '=', lit(0)), NULL_SIDE)).toBe(false);
    });

    it('does not reject when a CASE maps NULL onto a matching value', () => {
      const pred = bin(caseWhen(isNull(col('R', 'RV')), lit(1), lit(0)), '=', lit(1));
      expect(isNullRejecting(pred, NULL_SIDE)).toBe(false);
    });

    it('does not reject IS NULL on a nulled column', () => {
      expect(isNullRejecting(isNull(col('R', 'RV')), NULL_SIDE)).toBe(false);
    });

    it('does not reject an OR whose other branch can still be true', () => {
      const pred = bin(bin(col('R', 'RV'), '=', lit(1)), 'OR', isNull(col('R', 'RV')));
      expect(isNullRejecting(pred, NULL_SIDE)).toBe(false);
    });

    it('does not reject a predicate that never touches the nulled side', () => {
      expect(isNullRejecting(bin(col('L', 'LV'), '=', lit(1)), NULL_SIDE)).toBe(false);
    });
  });
});
