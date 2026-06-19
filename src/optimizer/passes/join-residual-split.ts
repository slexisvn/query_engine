import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalFilter, LogicalJoin, getChildren, type LogicalPlanNode, type LogicalJoinNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';

type MetadataValue = string | number | boolean | object | null | undefined;

interface PlanRefs { aliases: Set<string>; columns: Set<string>; }

interface ExprRef { tableAlias: string; columnName: string; }

interface NamedExpr { outputName?: string; alias?: string; name?: string; columnName?: string; }

type ExprLike = BoundExpr & {
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

export class JoinResidualSplit extends OptimizationPass {
  get name() { return 'JoinResidualSplit'; }

  apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new JoinResidualSplitRewriter();
    return rewriter.rewrite(plan);
  }
}

class JoinResidualSplitRewriter extends PlanRewriter {
  rewriteJoin(node: LogicalJoinNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    if (rewritten.joinType !== JoinType.INNER || !rewritten.condition) return rewritten;

    const leftRefs = collectPlanRefs(rewritten.children[0]);
    const rightRefs = collectPlanRefs(rewritten.children[1]);
    const joinPreds: BoundExpr[] = [];
    const residualPreds: BoundExpr[] = [];

    for (const pred of splitConjuncts(rewritten.condition)) {
      if (isCrossSideOr(pred, leftRefs, rightRefs)) residualPreds.push(pred);
      else joinPreds.push(pred);
    }

    if (residualPreds.length === 0 || joinPreds.length === 0) return rewritten;

    const join = LogicalJoin(
      rewritten.joinType,
      combineConjuncts(joinPreds),
      rewritten.children[0],
      rewritten.children[1],
      rewritten.physicalStrategy,
    );
    return LogicalFilter(combineConjuncts(residualPreds), copyJoinMetadata(join, rewritten));
  }
}

function copyJoinMetadata(target: LogicalJoinNode, source: LogicalJoinNode): LogicalJoinNode {
  const result = { ...target } as LogicalJoinNode & Record<string, MetadataValue>;
  const src = source as LogicalJoinNode & Record<string, MetadataValue>;
  for (const key of Object.keys(src)) {
    if (key.startsWith('_')) result[key] = src[key];
  }
  if (src.markColumn) result.markColumn = src.markColumn;
  return result;
}

function isCrossSideOr(expr: BoundExpr, leftRefs: PlanRefs, rightRefs: PlanRefs): boolean {
  if (!expr || expr.kind !== BoundExprKind.BINARY || expr.op !== 'OR') return false;
  const refs = collectExprRefs(expr);
  return refs.some((ref) => refBelongsToPlan(ref, leftRefs)) && refs.some((ref) => refBelongsToPlan(ref, rightRefs));
}

function collectExprRefs(expr: BoundExpr): ExprRef[] {
  const refs: ExprRef[] = [];
  walkExpr(expr, (e) => {
    if (e.kind === BoundExprKind.COLUMN_REF) {
      refs.push({
        tableAlias: (e.tableAlias || '').toUpperCase(),
        columnName: (e.columnName || '').toUpperCase(),
      });
    }
  });
  return refs;
}

function collectPlanRefs(node: LogicalPlanNode): PlanRefs {
  const refs: PlanRefs = { aliases: new Set<string>(), columns: new Set<string>() };
  addOutputRefs(node, refs);
  refs.aliases.delete('');
  refs.columns.delete('');
  return refs;
}

function addOutputRefs(node: LogicalPlanNode, refs: PlanRefs): void {
  if (!node) return;
  if (node.type === PlanNodeType.SCAN) {
    refs.aliases.add((node.alias || node.table || '').toUpperCase());
    for (const col of node.columns || []) refs.columns.add((col.name || (col as { columnName?: string }).columnName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.CTE_SCAN) {
    refs.aliases.add(((node as { alias?: string }).alias || node.cteName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.PROJECT) {
    for (const expr of node.expressions || []) refs.columns.add(outputName(expr as NamedExpr));
    return;
  }
  if (node.type === PlanNodeType.AGGREGATE) {
    for (const expr of node.groupBy || []) refs.columns.add(outputName(expr as NamedExpr));
    for (const agg of node.aggregates || []) refs.columns.add(outputName(agg as NamedExpr));
    return;
  }
  if (node.type === PlanNodeType.JOIN || node.type === PlanNodeType.UNION) {
    for (const child of getChildren(node)) addOutputRefs(child, refs);
    return;
  }
  if (node.children?.[0]) addOutputRefs(node.children[0], refs);
}

function outputName(expr: NamedExpr): string {
  return (expr?.outputName || expr?.alias || expr?.name || expr?.columnName || '').toUpperCase();
}

function refBelongsToPlan(ref: ExprRef, planRefs: PlanRefs): boolean {
  if (ref.tableAlias) return planRefs.aliases.has(ref.tableAlias);
  return planRefs.columns.has(ref.columnName);
}

function walkExpr(expr: BoundExpr | null | undefined, fn: (expr: BoundExpr) => void): void {
  if (!expr || typeof expr !== 'object') return;
  fn(expr);
  const e = expr as ExprLike;
  if (e.left) walkExpr(e.left, fn);
  if (e.right) walkExpr(e.right, fn);
  if (e.operand) walkExpr(e.operand, fn);
  if (e.expr) walkExpr(e.expr, fn);
  if (e.low) walkExpr(e.low, fn);
  if (e.high) walkExpr(e.high, fn);
  if (e.args) for (const arg of e.args) walkExpr(arg, fn);
  if (e.whenClauses) {
    for (const wc of e.whenClauses) {
      walkExpr(wc.condition, fn);
      walkExpr(wc.result, fn);
    }
  }
  if (e.elseExpr) walkExpr(e.elseExpr, fn);
  if (e.list && Array.isArray(e.list)) for (const item of e.list) walkExpr(item, fn);
  if (e.pattern) walkExpr(e.pattern, fn);
  if (e.source) walkExpr(e.source, fn);
}
