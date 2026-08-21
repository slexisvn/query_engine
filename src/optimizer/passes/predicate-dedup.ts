import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { LogicalFilter, type LogicalPlanNode, type LogicalFilterNode, type LogicalJoinNode } from '../../planner/logical-plan.js';
import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from '../../binder/conjuncts.js';
import { exprKey as canonicalExprKey } from '../../binder/expr-key.js';

export class PredicateDedup extends OptimizationPass {
  override get name() { return 'PredicateDedup'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new DedupRewriter();
    return rewriter.rewrite(plan);
  }
}

class DedupRewriter extends PlanRewriter {
  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    const child = this.rewrite(node.children[0]);
    const preds = splitConjuncts(node.condition);
    const unique = dedup(preds);

    if (unique.length === 0) return child;
    if (unique.length === preds.length && child === node.children[0]) return node;
    return LogicalFilter(combineConjuncts(unique), child);
  }

  override rewriteJoin(node: LogicalJoinNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    if (!newNode.condition) return newNode;

    const preds = splitConjuncts(newNode.condition);
    const unique = dedup(preds);

    if (unique.length === preds.length) return newNode;
    if (unique.length === 0) return { ...newNode, condition: null };
    return { ...newNode, condition: combineConjuncts(unique) };
  }
}

function dedup(predicates: BoundExpr[]): BoundExpr[] {
  const seen = new Set<string>();
  const result: BoundExpr[] = [];
  for (const pred of predicates) {
    const key = exprKey(pred);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(pred);
    }
  }
  return result;
}

const COMMUTATIVE_OPS: ReadonlySet<string> = new Set(['=', '<>', 'AND', 'OR', '+', '*']);

function exprKey(expr: BoundExpr | null): string {
  if (expr && expr.kind === BoundExprKind.BINARY && COMMUTATIVE_OPS.has(expr.op)) {
    const left = exprKey(expr.left);
    const right = exprKey(expr.right);
    const [first, second] = left < right ? [left, right] : [right, left];
    return `bin(${expr.op},${first},${second})`;
  }
  return canonicalExprKey(expr);
}
