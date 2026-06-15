import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalFilter, LogicalJoin, getChildren, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';

export class JoinResidualSplit extends OptimizationPass {
  get name() { return 'JoinResidualSplit'; }

  apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new JoinResidualSplitRewriter();
    return rewriter.rewrite(plan);
  }
}

class JoinResidualSplitRewriter extends PlanRewriter {
  rewriteJoin(node: any): any {
    const rewritten: any = this.rewriteChildren(node);
    if (rewritten.joinType !== JoinType.INNER || !rewritten.condition) return rewritten;

    const leftRefs = collectPlanRefs(rewritten.children[0]);
    const rightRefs = collectPlanRefs(rewritten.children[1]);
    const joinPreds: any[] = [];
    const residualPreds: any[] = [];

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

function copyJoinMetadata(target: any, source: any): any {
  const result: any = { ...target };
  for (const key of Object.keys(source)) {
    if (key.startsWith('_')) result[key] = source[key];
  }
  if (source.markColumn) result.markColumn = source.markColumn;
  return result;
}

function isCrossSideOr(expr: any, leftRefs: any, rightRefs: any): boolean {
  if (!expr || expr.kind !== BoundExprKind.BINARY || expr.op !== 'OR') return false;
  const refs = collectExprRefs(expr);
  return refs.some((ref: any) => refBelongsToPlan(ref, leftRefs)) && refs.some((ref: any) => refBelongsToPlan(ref, rightRefs));
}

function collectExprRefs(expr: any): any[] {
  const refs: any[] = [];
  walkExpr(expr, (e: any) => {
    if (e.kind === BoundExprKind.COLUMN_REF) {
      refs.push({
        tableAlias: (e.tableAlias || '').toUpperCase(),
        columnName: (e.columnName || '').toUpperCase(),
      });
    }
  });
  return refs;
}

function collectPlanRefs(node: any): any {
  const refs = { aliases: new Set<string>(), columns: new Set<string>() };
  addOutputRefs(node, refs);
  refs.aliases.delete('');
  refs.columns.delete('');
  return refs;
}

function addOutputRefs(node: any, refs: any): void {
  if (!node) return;
  if (node.type === PlanNodeType.SCAN) {
    refs.aliases.add((node.alias || node.table || '').toUpperCase());
    for (const col of node.columns || []) refs.columns.add((col.name || col.columnName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.CTE_SCAN) {
    refs.aliases.add((node.alias || node.cteName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.PROJECT) {
    for (const expr of node.expressions || []) refs.columns.add(outputName(expr));
    return;
  }
  if (node.type === PlanNodeType.AGGREGATE) {
    for (const expr of node.groupBy || []) refs.columns.add(outputName(expr));
    for (const agg of node.aggregates || []) refs.columns.add(outputName(agg));
    return;
  }
  if (node.type === PlanNodeType.JOIN || node.type === PlanNodeType.UNION) {
    for (const child of getChildren(node)) addOutputRefs(child, refs);
    return;
  }
  if (node.children?.[0]) addOutputRefs(node.children[0], refs);
}

function outputName(expr: any): string {
  return (expr?.outputName || expr?.alias || expr?.name || expr?.columnName || '').toUpperCase();
}

function refBelongsToPlan(ref: any, planRefs: any): boolean {
  if (ref.tableAlias) return planRefs.aliases.has(ref.tableAlias);
  return planRefs.columns.has(ref.columnName);
}

function walkExpr(expr: any, fn: (expr: any) => void): void {
  if (!expr || typeof expr !== 'object') return;
  fn(expr);
  if (expr.left) walkExpr(expr.left, fn);
  if (expr.right) walkExpr(expr.right, fn);
  if (expr.operand) walkExpr(expr.operand, fn);
  if (expr.expr) walkExpr(expr.expr, fn);
  if (expr.low) walkExpr(expr.low, fn);
  if (expr.high) walkExpr(expr.high, fn);
  if (expr.args) for (const arg of expr.args) walkExpr(arg, fn);
  if (expr.whenClauses) {
    for (const wc of expr.whenClauses) {
      walkExpr(wc.condition, fn);
      walkExpr(wc.result, fn);
    }
  }
  if (expr.elseExpr) walkExpr(expr.elseExpr, fn);
  if (expr.list && Array.isArray(expr.list)) for (const item of expr.list) walkExpr(item, fn);
  if (expr.pattern) walkExpr(expr.pattern, fn);
  if (expr.source) walkExpr(expr.source, fn);
}
