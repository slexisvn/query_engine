import { BoundExprKind, walkExpr, type BoundExpr } from '../binder/expression-binder.js';

export function containsAggregate(expr?: BoundExpr | null): boolean {
  let found = false;
  walkExpr(expr, (e) => { if (e.kind === BoundExprKind.AGGREGATE) found = true; });
  return found;
}

export function collectTableRefs(expr: BoundExpr | null | undefined): Set<string> {
  const refs = new Set<string>();
  walkExpr(expr, (e) => {
    if (e.kind === BoundExprKind.COLUMN_REF && e.tableAlias) {
      refs.add(e.tableAlias.toUpperCase());
    }
  });
  return refs;
}
