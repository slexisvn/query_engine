import { OptimizationPass } from '../pass.js';
import { JoinType, LogicalFilter, LogicalJoin, type LogicalPlanNode, type LogicalJoinNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';
import { walkExpr } from './expr-walk.js';
import { collectPlanRefs, refBelongsToPlan, type PlanRefs, type ExprRef } from './plan-refs.js';

type MetadataValue = string | number | boolean | object | null | undefined;

export class JoinResidualSplit extends OptimizationPass {
  override get name() { return 'JoinResidualSplit'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new JoinResidualSplitRewriter();
    return rewriter.rewrite(plan);
  }
}

class JoinResidualSplitRewriter extends PlanRewriter {
  override rewriteJoin(node: LogicalJoinNode): LogicalPlanNode {
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

