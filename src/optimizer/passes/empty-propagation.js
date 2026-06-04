import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, JoinType } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class EmptyPropagation extends OptimizationPass {
  get name() { return 'EmptyPropagation'; }

  apply(plan) {
    const rewriter = new EmptyPropagationRewriter();
    return rewriter.rewrite(plan);
  }
}

class EmptyPropagationRewriter extends PlanRewriter {
  rewriteDefault(node) {
    const newNode = this.rewriteChildren(node);

    if (newNode.children && newNode.children.length === 1 && newNode.children[0].type === PlanNodeType.EMPTY) {
      if (newNode.type === PlanNodeType.AGGREGATE && (!newNode.groupBy || newNode.groupBy.length === 0)) {
        return newNode; 
      }
      return newNode.children[0];
    }

        return newNode;
  }

  rewriteFilter(node) {
    const newNode = this.rewriteChildren(node);
    if (newNode.children[0].type === PlanNodeType.EMPTY) {
      return newNode.children[0];
    }

        if (newNode.condition && newNode.condition.kind === BoundExprKind.LITERAL && newNode.condition.value === false) {
      return { type: PlanNodeType.EMPTY, children: [newNode.children[0]] };
    }

        return newNode;
  }

    rewriteLimit(node) {
    const newNode = this.rewriteChildren(node);
    if (newNode.children[0].type === PlanNodeType.EMPTY) {
      return newNode.children[0];
    }

        if (newNode.count === 0) {
      return { type: PlanNodeType.EMPTY, children: [newNode.children[0]] };
    }

        return newNode;
  }

  rewriteJoin(node) {
    const newNode = this.rewriteChildren(node);
    const left = newNode.children[0];
    const right = newNode.children[1];

        const leftEmpty = left.type === PlanNodeType.EMPTY;
    const rightEmpty = right.type === PlanNodeType.EMPTY;

        if (newNode.joinType === JoinType.INNER || newNode.joinType === JoinType.CROSS) {
      if (leftEmpty || rightEmpty) {
        return { type: PlanNodeType.EMPTY, children: [newNode] };
      }
    } else if (newNode.joinType === JoinType.LEFT) {
      if (leftEmpty) {
        return { type: PlanNodeType.EMPTY, children: [newNode] };
      }
      if (rightEmpty) {
        return newNode;
      }
    } else if (newNode.joinType === JoinType.FULL) {
      if (leftEmpty && rightEmpty) {
         return { type: PlanNodeType.EMPTY, children: [newNode] };
      }
    }

        return newNode;
  }

  rewriteUnion(node) {
    const newNode = this.rewriteChildren(node);
    const left = newNode.children[0];
    const right = newNode.children[1];

        const leftEmpty = left.type === PlanNodeType.EMPTY;
    const rightEmpty = right.type === PlanNodeType.EMPTY;

        if (leftEmpty && rightEmpty) {
      return { type: PlanNodeType.EMPTY, children: [newNode] };
    }
    if (leftEmpty) return right;
    if (rightEmpty) return left;

        return newNode;
  }
}
