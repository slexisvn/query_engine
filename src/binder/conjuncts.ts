import { BoundExprKind } from './expression-binder.js';
import type { BoundExpr, BoundBinaryNode } from './expression-binder.js';
import { DataType } from '../storage/data-type.js';

const AND = 'AND';

export function splitConjuncts(expr: BoundExpr | null): BoundExpr[] {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op?.toUpperCase() === AND) {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

export function combineConjuncts(preds: BoundExpr[]): BoundExpr | null {
  if (preds.length === 0) return null;
  if (preds.length === 1) return preds[0];
  return preds.reduce((acc, pred): BoundBinaryNode => ({
    kind: BoundExprKind.BINARY,
    op: AND,
    left: acc,
    right: pred,
    resultType: DataType.BOOLEAN,
  }));
}
