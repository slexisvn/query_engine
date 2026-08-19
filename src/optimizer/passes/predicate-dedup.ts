import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, LogicalFilter, type LogicalPlanNode, type LogicalFilterNode, type LogicalJoinNode } from '../../planner/logical-plan.js';
import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';

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

function exprKey(expr: BoundExpr | null): string {
  if (!expr || typeof expr !== 'object') return String(expr);
  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF:
      return `COL:${(expr.tableAlias || '').toUpperCase()}.${(expr.columnName || '').toUpperCase()}`;
    case BoundExprKind.LITERAL:
      return `LIT:${String(expr.value)}:${expr.dataType || ''}`;
    case BoundExprKind.BINARY: {
      const l = exprKey(expr.left);
      const r = exprKey(expr.right);
      const op = expr.op;
      if (['=', '<>', 'AND', 'OR', '+', '*'].includes(op)) {
        return `BIN:${op}:${l < r ? l : r}:${l < r ? r : l}`;
      }
      return `BIN:${op}:${l}:${r}`;
    }
    case BoundExprKind.UNARY:
      return `UNARY:${expr.op}:${exprKey(expr.operand)}`;
    case BoundExprKind.LIKE:
      return `LIKE:${expr.negated}:${exprKey(expr.expr)}:${exprKey(expr.pattern)}`;
    case BoundExprKind.IN_LIST:
      return `IN:${expr.negated}:${exprKey(expr.expr)}:${Array.isArray(expr.list) ? expr.list.map(exprKey).join(',') : exprKey(expr.list)}`;
    case BoundExprKind.BETWEEN:
      return `BTW:${expr.negated}:${exprKey(expr.expr)}:${exprKey(expr.low)}:${exprKey(expr.high)}`;
    case BoundExprKind.IS_NULL:
      return `ISNULL:${expr.negated}:${exprKey(expr.expr)}`;
    case BoundExprKind.AGGREGATE:
      return `AGG:${expr.name}:${expr.distinct}:${expr.args.map(exprKey).join(',')}`;
    case BoundExprKind.FUNCTION:
      return `FN:${expr.name}:${expr.args.map(exprKey).join(',')}`;
    case BoundExprKind.EXTRACT:
      return `EXT:${expr.field}:${exprKey(expr.source)}`;
    case BoundExprKind.CASE:
      return `CASE:${expr.whenClauses.map((wc) => `${exprKey(wc.condition)}:${exprKey(wc.result)}`).join(';')}:${exprKey(expr.elseExpr)}`;
    default:
      return JSON.stringify(expr).slice(0, 100);
  }
}
