import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, type LogicalPlanNode, type LogicalFilterNode } from '../../planner/logical-plan.js';
import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';

export class HavingPushdown extends OptimizationPass {
  override get name() { return 'HavingPushdown'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new HavingPushdownRewriter();
    return rewriter.rewrite(plan);
  }
}

class HavingPushdownRewriter extends PlanRewriter {
  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    let child: LogicalPlanNode = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.AGGREGATE) {
      const predicates = splitConjuncts(node.condition);

            const pushable: BoundExpr[] = [];
      const unpushable: BoundExpr[] = [];

            for (const pred of predicates) {
        if (containsAggregate(pred)) {
          unpushable.push(pred);
        } else {
          pushable.push(pred);
        }
      }

            if (pushable.length > 0) {
        const aggChild = child.children[0];
        const pushedCond = combineConjuncts(pushable);

        const newBottomFilter: LogicalFilterNode = {
          type: PlanNodeType.FILTER,
          condition: pushedCond,
          children: [aggChild]
        };

        child = { ...child, children: [newBottomFilter] };

                if (unpushable.length === 0) {
          return child;
        } else {
          return { ...node, condition: combineConjuncts(unpushable), children: [child] };
        }
      }
    }

        if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }
}

function containsAggregate(expr: BoundExpr | null): boolean {
  if (!expr) return false;
  if (expr.kind === BoundExprKind.AGGREGATE) return true;

    if (expr.kind === BoundExprKind.BINARY) {
    return containsAggregate(expr.left) || containsAggregate(expr.right);
  }
  if (expr.kind === BoundExprKind.UNARY) {
    return containsAggregate(expr.operand);
  }
  if (expr.kind === BoundExprKind.FUNCTION || expr.kind === BoundExprKind.CASE) {
    if (expr.kind === BoundExprKind.FUNCTION && expr.args) {
      return expr.args.some(containsAggregate);
    }
    if (expr.kind === BoundExprKind.CASE && expr.whenClauses) {
      for (const wc of expr.whenClauses) {
        if (containsAggregate(wc.condition) || containsAggregate(wc.result)) return true;
      }
    }
    if (expr.kind === BoundExprKind.CASE && expr.operand && containsAggregate(expr.operand)) return true;
    if (expr.kind === BoundExprKind.CASE && expr.elseExpr && containsAggregate(expr.elseExpr)) return true;
  }

    return false;
}
