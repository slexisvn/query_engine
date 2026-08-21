import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { type LogicalPlanNode, type LogicalDistinctNode } from '../../planner/logical-plan.js';
import { producesDistinctRows, type UniqueKeyCatalog } from '../unique-keys.js';

export class DistinctElimination extends OptimizationPass {
  catalog: UniqueKeyCatalog | null;

  constructor(catalog: UniqueKeyCatalog | null = null) {
    super();
    this.catalog = catalog;
  }

  override get name() { return 'DistinctElimination'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    return new DistinctEliminationRewriter(this.catalog).rewrite(plan);
  }
}

class DistinctEliminationRewriter extends PlanRewriter {
  catalog: UniqueKeyCatalog | null;

  constructor(catalog: UniqueKeyCatalog | null) {
    super();
    this.catalog = catalog;
  }

  override rewriteDistinct(node: LogicalDistinctNode): LogicalPlanNode {
    const child: LogicalPlanNode = this.rewrite(node.children[0]);

    if (producesDistinctRows(child, this.catalog)) return child;

    return child === node.children[0] ? node : { ...node, children: [child] };
  }
}
