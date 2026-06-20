import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, type LogicalPlanNode, type LogicalLimitNode, type LogicalTopNNode, type LogicalSortNode } from '../../planner/logical-plan.js';

export class TopNFusion extends OptimizationPass {
  override get name() { return 'TopNFusion'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new TopNFusionRewriter();
    return rewriter.rewrite(plan);
  }
}

class TopNFusionRewriter extends PlanRewriter {
  override rewriteLimit(node: LogicalLimitNode): LogicalPlanNode {
    const child: LogicalPlanNode = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.SORT) {
      const topN: LogicalTopNNode = {
        type: PlanNodeType.TOP_N,
        orderKeys: child.orderKeys,
        count: node.count,
        offset: node.offset || 0,
        children: child.children,
        _sortedBy: child._sortedBy,
        _cardinality: Math.min(node.count, child._cardinality || Infinity),
      };
      return topN;
    }

    if (child.type === PlanNodeType.PROJECT && child.children[0]?.type === PlanNodeType.SORT) {
      const sort = child.children[0] as LogicalSortNode;
      const topN: LogicalTopNNode = {
        type: PlanNodeType.TOP_N,
        orderKeys: sort.orderKeys,
        count: node.count,
        offset: node.offset || 0,
        children: sort.children,
        _sortedBy: sort._sortedBy,
        _cardinality: Math.min(node.count, sort._cardinality || Infinity),
      };
      return { ...child, children: [topN] };
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }
}
