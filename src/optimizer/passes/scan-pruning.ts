import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, type LogicalFilterNode, type LogicalPlanNode, type LogicalScanNode } from '../../planner/logical-plan.js';

export class ScanPruning extends OptimizationPass {
  override get name() { return 'ScanPruning'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    return new ScanPruningRewriter().rewrite(plan);
  }
}

class ScanPruningRewriter extends PlanRewriter {
  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    const child = this.rewrite(node.children[0]);
    if (child.type !== PlanNodeType.SCAN || !node.condition) {
      return child === node.children[0] ? node : { ...node, children: [child] };
    }

    const scan: LogicalScanNode = { ...child, pruningFilter: node.condition };
    return { ...node, children: [scan] };
  }
}
