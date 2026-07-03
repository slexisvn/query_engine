import type { BoundExpr } from '../../binder/expression-binder.js';

export function splitAnd(expr: BoundExpr | null): BoundExpr[] {
  if (!expr) return [];
  if ((expr as { op?: string }).op?.toUpperCase() === 'AND') {
    return [...splitAnd((expr as { left?: BoundExpr }).left ?? null), ...splitAnd((expr as { right?: BoundExpr }).right ?? null)];
  }
  return [expr];
}
