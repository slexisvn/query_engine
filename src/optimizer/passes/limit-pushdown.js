import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType } from '../../planner/logical-plan.js';

export class LimitPushdown extends OptimizationPass {
  get name() { return 'LimitPushdown'; }

  apply(plan) {
    const rewriter = new LimitPushdownRewriter();
    return rewriter.rewrite(plan);
  }
}

class LimitPushdownRewriter extends PlanRewriter {
  rewriteLimit(node) {
    const child = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.PROJECT) {
      const newLimit = { ...node, children: [child.children[0]] };
      const newProject = { ...child, children: [newLimit] };
      const optimizedLimit = this.rewrite(newLimit);
      return { ...newProject, children: [optimizedLimit] };
    }

    if (child.type === PlanNodeType.UNION && child.all) {
      const leftLimit = { ...node, children: [child.children[0]] };
      const rightLimit = { ...node, children: [child.children[1]] };

            const newUnion = { 
        ...child, 
        children: [
          this.rewrite(leftLimit), 
          this.rewrite(rightLimit)
        ] 
      };

      return { ...node, children: [newUnion] };
    }

    if (child.type === PlanNodeType.SORT) {
      const newSort = { ...child, limit: node.count, offset: node.offset || 0 };
      return { ...node, children: [newSort] };
    }

    if (child.type === PlanNodeType.AGGREGATE && child.groupBy && child.groupBy.length > 0) {
      const newAgg = { ...child, _limitHint: node.count + (node.offset || 0) };
      return { ...node, children: [newAgg] };
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }

        return node;
  }
}
