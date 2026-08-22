import { BoundExprKind, type BoundColumnRefNode, type BoundExpr, type LiteralValue } from '../../binder/expression-binder.js';
import type { PlanRefs } from './plan-refs.js';

type EvalResult = LiteralValue | undefined;

export type NullColumnPredicate = (ref: BoundColumnRefNode) => boolean;

export type NullColumnSource = PlanRefs | NullColumnPredicate;

function suppliesNull(source: NullColumnSource): NullColumnPredicate {
  if (typeof source === 'function') return source;
  return (ref) => (ref.tableAlias
    ? source.aliases.has(ref.tableAlias.toUpperCase())
    : source.columns.has((ref.columnName || '').toUpperCase()));
}

export function isNullRejecting(expr: BoundExpr, nullSupplyingRefs: NullColumnSource): boolean {
  const result = evaluateWithNulls(expr, suppliesNull(nullSupplyingRefs));
  return result === false || result === null;
}

function evaluateWithNulls(expr: BoundExpr | null | undefined, nullRefs: NullColumnPredicate): EvalResult {
  if (!expr) return undefined;

    switch (expr.kind) {
    case BoundExprKind.LITERAL:
      return expr.value;

          case BoundExprKind.COLUMN_REF:
      return nullRefs(expr) ? null : 'UNKNOWN';

          case BoundExprKind.BINARY: {
      const left = evaluateWithNulls(expr.left, nullRefs);
      const right = evaluateWithNulls(expr.right, nullRefs);
      const op = expr.op.toUpperCase();

            if (op === 'AND') {
        if (left === false || right === false) return false;
        if (left === null || right === null) return null;
        if (left === 'UNKNOWN' || right === 'UNKNOWN') return 'UNKNOWN';
        return true;
      }
      if (op === 'OR') {
        if (left === true || right === true) return true;
        if (left === 'UNKNOWN' || right === 'UNKNOWN') return 'UNKNOWN';
        if (left === null && right === null) return null;
        return false;
      }

            if (left === null || right === null) return null;

            return 'UNKNOWN';
    }

          case BoundExprKind.UNARY: {
      const operand = evaluateWithNulls(expr.operand, nullRefs);
      if (operand === null) return null;
      return 'UNKNOWN';
    }

          case BoundExprKind.FUNCTION:
    case BoundExprKind.EXTRACT:
    case BoundExprKind.CAST:
    case BoundExprKind.INTERVAL:
    case BoundExprKind.CASE:
    case BoundExprKind.AGGREGATE:
      return 'UNKNOWN';

          case BoundExprKind.IS_NULL: {
      const operand = evaluateWithNulls(expr.expr, nullRefs);
      if (operand === 'UNKNOWN' || operand === undefined) return 'UNKNOWN';
      return expr.negated ? operand !== null : operand === null;
    }
  }

    return 'UNKNOWN';
}
