import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { type LogicalPlanNode, type LogicalSortNode } from '../../planner/logical-plan.js';
import { columnKeyOf, sortDirectionOf, sortKeyMatches } from '../sort-properties.js';

interface RequiredKey { key: string | null; direction: string; }

export class SortElimination extends OptimizationPass {
  override get name() { return 'SortElimination'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new SortEliminationRewriter();
    return rewriter.rewrite(plan);
  }
}

class SortEliminationRewriter extends PlanRewriter {
  override rewriteSort(node: LogicalSortNode): LogicalPlanNode {
    const child: LogicalPlanNode = this.rewrite(node.children[0]);

    if (!child._sortedBy || child._sortedBy.length === 0) {
      if (child !== node.children[0]) {
        return { ...node, children: [child] };
      }
      return node;
    }

    const requiredKeys: RequiredKey[] = node.orderKeys.map((ok) => ({
      key: columnKeyOf(ok.expr),
      direction: (ok.direction || 'ASC').toUpperCase(),
    }));

    if (requiredKeys.some((k) => !k.key)) {
      if (child !== node.children[0]) {
        return { ...node, children: [child] };
      }
      return node;
    }

    const childSorted = child._sortedBy;
    let match = requiredKeys.length <= childSorted.length;
    for (let i = 0; match && i < requiredKeys.length; i++) {
      if (!sortKeyMatches(childSorted[i], requiredKeys[i].key)) { match = false; break; }
      if (sortDirectionOf(childSorted[i]) !== requiredKeys[i].direction) { match = false; break; }
    }

    if (match) {
      return child;
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }
}
