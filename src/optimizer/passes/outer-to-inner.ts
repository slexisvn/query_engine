import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, JoinType, type LogicalPlanNode, type LogicalFilterNode } from '../../planner/logical-plan.js';
import { BoundExprKind, type BoundExpr, type LiteralValue } from '../../binder/expression-binder.js';
import { splitConjuncts } from './predicate-pushdown.js';
import { collectPlanRefs, type PlanRefs } from './plan-refs.js';

type EvalResult = LiteralValue | undefined;

export class OuterToInnerJoin extends OptimizationPass {
  override get name() { return 'OuterToInnerJoin'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new OuterToInnerRewriter();
    return rewriter.rewrite(plan);
  }
}

class OuterToInnerRewriter extends PlanRewriter {
  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    let child: LogicalPlanNode = this.rewrite(node.children[0]);

        if (child.type === PlanNodeType.JOIN && (child.joinType === JoinType.LEFT || child.joinType === JoinType.FULL || child.joinType === JoinType.RIGHT || child.joinType === JoinType.SINGLE)) {
      const leftRefs = collectPlanRefs(child.children[0]);
      const rightRefs = collectPlanRefs(child.children[1]);

            const predicates = splitConjuncts(node.condition);

            let rejectRightNulls = false;
      let rejectLeftNulls = false;

            for (const pred of predicates) {
        if (isNullRejecting(pred, rightRefs)) {
          rejectRightNulls = true;
        }
        if (isNullRejecting(pred, leftRefs)) {
          rejectLeftNulls = true;
        }
      }

            let newJoinType: JoinType = child.joinType;

            if (child.joinType === JoinType.LEFT && rejectRightNulls) {
        newJoinType = JoinType.INNER;
      } else if (child.joinType === JoinType.SINGLE && rejectRightNulls) {
        newJoinType = JoinType.INNER;
      } else if (child.joinType === JoinType.RIGHT && rejectLeftNulls) {
        newJoinType = JoinType.INNER;
      } else if (child.joinType === JoinType.FULL) {
        if (rejectLeftNulls && rejectRightNulls) newJoinType = JoinType.INNER;
        else if (rejectLeftNulls) newJoinType = JoinType.LEFT;
        else if (rejectRightNulls) newJoinType = JoinType.RIGHT;
      }

            if (newJoinType !== child.joinType) {
        child = { ...child, joinType: newJoinType };
      }
    }

        if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }
}

function isNullRejecting(expr: BoundExpr, nullSupplyingRefs: PlanRefs): boolean {
  const result = evaluateWithNulls(expr, nullSupplyingRefs);
  return result === false || result === null;
}

function evaluateWithNulls(expr: BoundExpr | null | undefined, nullRefs: PlanRefs): EvalResult {
  if (!expr) return undefined;

    switch (expr.kind) {
    case BoundExprKind.LITERAL:
      return expr.value;

          case BoundExprKind.COLUMN_REF:
      if (expr.tableAlias && nullRefs.aliases.has(expr.tableAlias.toUpperCase())) {
        return null;
      }
      if (!expr.tableAlias && nullRefs.columns.has((expr.columnName || '').toUpperCase())) {
        return null;
      }
      return 'UNKNOWN';

          case BoundExprKind.BINARY: {
      const left = evaluateWithNulls(expr.left, nullRefs);
      const right = evaluateWithNulls(expr.right, nullRefs);
      const op = expr.op.toUpperCase();

            if (op === 'AND') {
        if (left === false || right === false) return false;
        if (left === null || right === null) return null;
        if (left === 'UNKNOWN' || right === 'UNKNOWN') return 'UNKNOWN';
        return true;
      }
      if (op === 'OR') {
        if (left === true || right === true) return true;
        if (left === 'UNKNOWN' || right === 'UNKNOWN') return 'UNKNOWN';
        if (left === null && right === null) return null;
        return false;
      }

            if (left === null || right === null) return null;

            return 'UNKNOWN';
    }

          case BoundExprKind.UNARY: {
      const operand = evaluateWithNulls(expr.operand, nullRefs);
      if (operand === null) return null;
      return 'UNKNOWN';
    }

          case BoundExprKind.FUNCTION:
    case BoundExprKind.EXTRACT:
    case BoundExprKind.CAST:
    case BoundExprKind.INTERVAL:
    case BoundExprKind.CASE:
    case BoundExprKind.AGGREGATE:
      return 'UNKNOWN';

          case BoundExprKind.IS_NULL: {
      const operand = evaluateWithNulls((expr as { operand?: BoundExpr }).operand, nullRefs);
      if (operand === null) {
        return true;
      }
      return 'UNKNOWN';
    }
  }

    return 'UNKNOWN';
}
