import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';

export type ExprLike = BoundExpr & {
  left?: BoundExpr;
  right?: BoundExpr;
  operand?: BoundExpr;
  expr?: BoundExpr;
  low?: BoundExpr;
  high?: BoundExpr;
  args?: BoundExpr[];
  whenClauses?: Array<{ condition: BoundExpr; result: BoundExpr }>;
  elseExpr?: BoundExpr;
  list?: BoundExpr | BoundExpr[];
  pattern?: BoundExpr;
  source?: BoundExpr;
};

export function walkExpr(expr: BoundExpr | null | undefined, fn: (e: BoundExpr) => void): void {
  if (!expr || typeof expr !== 'object') return;
  fn(expr);
  const e = expr as ExprLike;
  if (e.left) walkExpr(e.left, fn);
  if (e.right) walkExpr(e.right, fn);
  if (e.operand) walkExpr(e.operand, fn);
  if (e.expr) walkExpr(e.expr, fn);
  if (e.low) walkExpr(e.low, fn);
  if (e.high) walkExpr(e.high, fn);
  if (e.args) for (const a of e.args) walkExpr(a, fn);
  if (e.whenClauses) for (const wc of e.whenClauses) { walkExpr(wc.condition, fn); walkExpr(wc.result, fn); }
  if (e.elseExpr) walkExpr(e.elseExpr, fn);
  if (e.list && Array.isArray(e.list)) for (const item of e.list) walkExpr(item, fn);
  if (e.pattern) walkExpr(e.pattern, fn);
  if (e.source) walkExpr(e.source, fn);
}

export function containsAggregate(expr?: BoundExpr): boolean {
  let found = false;
  walkExpr(expr, (e) => { if (e.kind === BoundExprKind.AGGREGATE) found = true; });
  return found;
}
