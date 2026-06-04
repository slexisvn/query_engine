import { OptimizationPass } from '../pass.js';
import { PlanNodeType, LogicalMaterialize, LogicalCTEScan, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';

export class CTEOptimization extends OptimizationPass {
  get name() { return 'CTEOptimization'; }

  apply(plan) {
    const refCounts = countCTERefs(plan);
    const rewriter = new CTERewriter(refCounts);
    return rewriter.rewrite(plan);
  }
}

function countCTERefs(node) {
  const counts = new Map();
  _walkPlan(node, n => {
    if (n.type === PlanNodeType.CTE_SCAN) {
      const key = n.cteName.toUpperCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });
  return counts;
}

class CTERewriter extends PlanRewriter {
  constructor(refCounts) {
    super();
    this.refCounts = refCounts;
    this.ctePlans = new Map();
  }

  rewriteCTEAnchor(node) {
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

  rewriteCTEScan(node) {
    const key = node.cteName.toUpperCase();
    const plan = this.ctePlans.get(key);
    if (plan) {
      return plan;
    }
    return node;
  }
}

function _walkPlan(node, fn) {
  if (!node) return;
  fn(node);
  for (const child of getChildren(node)) _walkPlan(child, fn);
}
