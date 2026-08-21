import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, SetOpType, type LogicalPlanNode, type LogicalLimitNode } from '../../planner/logical-plan.js';

export class LimitPushdown extends OptimizationPass {
  override get name() { return 'LimitPushdown'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new LimitPushdownRewriter();
    return rewriter.rewrite(plan);
  }
}

class LimitPushdownRewriter extends PlanRewriter {
  override rewriteLimit(node: LogicalLimitNode): LogicalPlanNode {
    const child: LogicalPlanNode = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.PROJECT) {
      const newLimit = { ...node, children: [child.children[0]] };
      const newProject = { ...child, children: [newLimit] };
      const optimizedLimit = this.rewrite(newLimit);
      return { ...newProject, children: [optimizedLimit] };
    }

    if (child.type === PlanNodeType.SET_OP && child.op === SetOpType.UNION && child.all) {
      const branchLimit = { ...node, count: node.count + (node.offset || 0), offset: 0 };
      const leftLimit = { ...branchLimit, children: [child.children[0]] };
      const rightLimit = { ...branchLimit, children: [child.children[1]] };

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
      const newSort = { ...child, limit: node.count + (node.offset || 0), offset: 0 };
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
