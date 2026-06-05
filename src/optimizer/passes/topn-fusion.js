import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType } from '../../planner/logical-plan.js';

export class TopNFusion extends OptimizationPass {
  get name() { return 'TopNFusion'; }

  apply(plan) {
    const rewriter = new TopNFusionRewriter();
    return rewriter.rewrite(plan);
  }
}

class TopNFusionRewriter extends PlanRewriter {
  rewriteLimit(node) {
    const child = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.SORT) {
      return {
        type: PlanNodeType.TOP_N,
        orderKeys: child.orderKeys,
        count: node.count,
        offset: node.offset || 0,
        children: child.children,
        _sortedBy: child._sortedBy,
        _cardinality: Math.min(node.count, child._cardinality || Infinity),
      };
    }

    if (child.type === PlanNodeType.PROJECT && child.children[0]?.type === PlanNodeType.SORT) {
      const sort = child.children[0];
      const topN = {
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
