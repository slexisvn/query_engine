import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, JoinType, type LogicalPlanNode, type LogicalFilterNode, type LogicalLimitNode, type LogicalJoinNode, type LogicalSetOpNode, type LogicalEmptyNode } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class EmptyPropagation extends OptimizationPass {
  override get name() { return 'EmptyPropagation'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new EmptyPropagationRewriter();
    return rewriter.rewrite(plan);
  }
}

class EmptyPropagationRewriter extends PlanRewriter {
  override rewriteDefault(node: LogicalPlanNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    const children = newNode.children;

    if (children && children.length === 1 && children[0].type === PlanNodeType.EMPTY) {
      if (newNode.type === PlanNodeType.AGGREGATE && (!newNode.groupBy || newNode.groupBy.length === 0)) {
        return newNode;
      }
      return children[0];
    }

        return newNode;
  }

  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    if (newNode.children[0].type === PlanNodeType.EMPTY) {
      return newNode.children[0];
    }

        if (newNode.condition && newNode.condition.kind === BoundExprKind.LITERAL && newNode.condition.value === false) {
      const empty: LogicalEmptyNode = { type: PlanNodeType.EMPTY, children: [newNode.children[0]] };
      return empty;
    }

        return newNode;
  }

    override rewriteLimit(node: LogicalLimitNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    if (newNode.children[0].type === PlanNodeType.EMPTY) {
      return newNode.children[0];
    }

        if (newNode.count === 0) {
      const empty: LogicalEmptyNode = { type: PlanNodeType.EMPTY, children: [newNode.children[0]] };
      return empty;
    }

        return newNode;
  }

  override rewriteJoin(node: LogicalJoinNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    const left = newNode.children[0];
    const right = newNode.children[1];

        const leftEmpty = left.type === PlanNodeType.EMPTY;
    const rightEmpty = right.type === PlanNodeType.EMPTY;

        if (newNode.joinType === JoinType.INNER || newNode.joinType === JoinType.CROSS) {
      if (leftEmpty || rightEmpty) {
        const empty: LogicalEmptyNode = { type: PlanNodeType.EMPTY, children: [newNode] };
        return empty;
      }
    } else if (newNode.joinType === JoinType.LEFT) {
      if (leftEmpty) {
        const empty: LogicalEmptyNode = { type: PlanNodeType.EMPTY, children: [newNode] };
        return empty;
      }
      if (rightEmpty) {
        return newNode;
      }
    } else if (newNode.joinType === JoinType.FULL) {
      if (leftEmpty && rightEmpty) {
         const empty: LogicalEmptyNode = { type: PlanNodeType.EMPTY, children: [newNode] };
         return empty;
      }
    }

        return newNode;
  }

  override rewriteSetOp(node: LogicalSetOpNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    const left = newNode.children[0];
    const right = newNode.children[1];

        const leftEmpty = left.type === PlanNodeType.EMPTY;
    const rightEmpty = right.type === PlanNodeType.EMPTY;

        if (leftEmpty && rightEmpty) {
      const empty: LogicalEmptyNode = { type: PlanNodeType.EMPTY, children: [newNode] };
      return empty;
    }
    if (leftEmpty) return right;
    if (rightEmpty) return left;

        return newNode;
  }
}
