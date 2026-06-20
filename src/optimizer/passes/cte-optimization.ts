import { OptimizationPass } from '../pass.js';
import { PlanNodeType, LogicalMaterialize, LogicalCTEScan, getChildren, setChildren, type LogicalPlanNode, type LogicalCTEAnchorNode, type LogicalCTEScanNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';

export class CTEOptimization extends OptimizationPass {
  override get name() { return 'CTEOptimization'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const refCounts = countCTERefs(plan);
    const rewriter = new CTERewriter(refCounts);
    return rewriter.rewrite(plan);
  }
}

function countCTERefs(node: LogicalPlanNode): Map<string, number> {
  const counts = new Map<string, number>();
  _walkPlan(node, (n: LogicalPlanNode) => {
    if (n.type === PlanNodeType.CTE_SCAN) {
      const key = n.cteName.toUpperCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });
  return counts;
}

class CTERewriter extends PlanRewriter {
  refCounts: Map<string, number>;
  ctePlans: Map<string, LogicalPlanNode>;
  constructor(refCounts: Map<string, number>) {
    super();
    this.refCounts = refCounts;
    this.ctePlans = new Map();
  }

  override rewriteCTEAnchor(node: LogicalCTEAnchorNode): LogicalPlanNode {
    const producer = this.rewrite(node.children[0]);
    const consumer = this.rewrite(node.children[1]);
    const key = node.cteName.toUpperCase();
    const count = this.refCounts.get(key) || 0;

    if (count <= 1) {
      this.ctePlans.set(key, producer);
      return consumer;
    }

    this.ctePlans.set(key, LogicalMaterialize(producer));
    return consumer;
  }

  override rewriteCTEScan(node: LogicalCTEScanNode): LogicalPlanNode {
    const key = node.cteName.toUpperCase();
    const plan = this.ctePlans.get(key);
    if (plan) {
      return plan;
    }
    return node;
  }
}

function _walkPlan(node: LogicalPlanNode, fn: (node: LogicalPlanNode) => void): void {
  if (!node) return;
  fn(node);
  for (const child of getChildren(node)) _walkPlan(child, fn);
}
