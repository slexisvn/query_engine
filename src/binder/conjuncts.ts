import { BoundExprKind } from './expression-binder.js';
import type { BoundExpr, BoundBinaryNode } from './expression-binder.js';
import { DataType } from '../storage/data-type.js';

const AND = 'AND';

function isConjunction(expr: BoundExpr): expr is BoundBinaryNode {
  return expr.kind === BoundExprKind.BINARY && expr.op?.toUpperCase() === AND;
}

export function splitConjuncts(expr: BoundExpr | null): BoundExpr[] {
  if (!expr) return [];

  const conjuncts: BoundExpr[] = [];
  const pending: BoundExpr[] = [expr];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (isConjunction(current)) {
      pending.push(current.right, current.left);
      continue;
    }
    conjuncts.push(current);
  }
  return conjuncts;
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
