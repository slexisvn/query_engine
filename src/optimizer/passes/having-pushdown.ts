import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class HavingPushdown extends OptimizationPass {
  get name() { return 'HavingPushdown'; }

  apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new HavingPushdownRewriter();
    return rewriter.rewrite(plan);
  }
}

class HavingPushdownRewriter extends PlanRewriter {
  rewriteFilter(node: any): any {
    let child: any = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.AGGREGATE) {
      const predicates = splitConjuncts(node.condition);

            const pushable: any[] = [];
      const unpushable: any[] = [];

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

        const newBottomFilter = {
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

function splitConjuncts(expr: any): any[] {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op?.toUpperCase() === 'AND') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

function combineConjuncts(exprs: any[]): any {
  if (!exprs || exprs.length === 0) return null;
  let result = exprs[0];
  for (let i = 1; i < exprs.length; i++) {
    result = {
      kind: BoundExprKind.BINARY,
      op: 'AND',
      left: result,
      right: exprs[i],
      resultType: 'BOOLEAN' 
    };
  }
  return result;
}

function containsAggregate(expr: any): boolean {
  if (!expr) return false;
  if (expr.kind === BoundExprKind.AGGREGATE) return true;

    if (expr.kind === BoundExprKind.BINARY) {
    return containsAggregate(expr.left) || containsAggregate(expr.right);
  }
  if (expr.kind === BoundExprKind.UNARY) {
    return containsAggregate(expr.operand);
  }
  if (expr.kind === BoundExprKind.FUNCTION || expr.kind === BoundExprKind.CASE) {
    if (expr.args) {
      return expr.args.some(containsAggregate);
    }
    if (expr.whenClauses) {
      for (const wc of expr.whenClauses) {
        if (containsAggregate(wc.condition) || containsAggregate(wc.result)) return true;
      }
    }
    if (expr.operand && containsAggregate(expr.operand)) return true;
    if (expr.elseExpr && containsAggregate(expr.elseExpr)) return true;
  }

    return false;
}
