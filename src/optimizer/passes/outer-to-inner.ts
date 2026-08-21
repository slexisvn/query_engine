import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, JoinType, type LogicalPlanNode, type LogicalFilterNode } from '../../planner/logical-plan.js';
import { splitConjuncts } from '../../binder/conjuncts.js';
import { collectPlanRefs } from './plan-refs.js';
import { isNullRejecting } from './null-rejection.js';

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
