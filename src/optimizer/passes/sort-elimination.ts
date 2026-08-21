import { OptimizationPass, type OptimizationContext } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, type LogicalPlanNode, type LogicalSortNode } from '../../planner/logical-plan.js';
import { columnKeyOf, sortDirectionOf, sortKeyMatches } from '../../planner/sort-properties.js';

interface RequiredKey { key: string | null; direction: string; }

const ORDER_REQUIRED = true;
const ORDER_IGNORED = false;

const CHILD_ORDER_REQUIREMENT: Partial<Record<PlanNodeType, boolean>> = {
  [PlanNodeType.SORT]: ORDER_IGNORED,
  [PlanNodeType.TOP_N]: ORDER_IGNORED,
  [PlanNodeType.AGGREGATE]: ORDER_IGNORED,
  [PlanNodeType.PARTIAL_AGGREGATE]: ORDER_IGNORED,
  [PlanNodeType.FINAL_AGGREGATE]: ORDER_IGNORED,
  [PlanNodeType.LIMIT]: ORDER_REQUIRED,
  [PlanNodeType.WINDOW]: ORDER_REQUIRED,
  [PlanNodeType.MERGE_EXCHANGE]: ORDER_REQUIRED,
  [PlanNodeType.CTE_ANCHOR]: ORDER_REQUIRED,
};

function selectsRows(node: LogicalSortNode): boolean {
  return node.limit !== undefined || !!node.offset;
}

function withoutSortedProperty(node: LogicalPlanNode): LogicalPlanNode {
  if (node._sortedBy === undefined) return node;
  const { _sortedBy: _discarded, ...rest } = node;
  return rest as LogicalPlanNode;
}

export function cteScanOrderRequirements(plan: LogicalPlanNode, into: Map<string, boolean> = new Map()): Map<string, boolean> {
  const visit = (node: LogicalPlanNode, orderRequired: boolean): void => {
    if (node.type === PlanNodeType.CTE_SCAN) {
      const key = node.cteName.toUpperCase();
      into.set(key, (into.get(key) ?? false) || orderRequired);
      return;
    }
    const childRequirement = CHILD_ORDER_REQUIREMENT[node.type] ?? orderRequired;
    for (const child of node.children ?? []) visit(child, childRequirement);
  };
  visit(plan, ORDER_REQUIRED);
  return into;
}

export class SortElimination extends OptimizationPass {
  override get name() { return 'SortElimination'; }

  override apply(plan: LogicalPlanNode, context?: OptimizationContext): LogicalPlanNode {
    const withoutRedundantSorts = new SortEliminationRewriter().rewrite(plan);
    return new UnobservedSortRewriter().rewrite(withoutRedundantSorts, context?.rootOrderRequired ?? ORDER_REQUIRED);
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

    if (match && !selectsRows(node)) {
      return child;
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }
}

class UnobservedSortRewriter extends PlanRewriter<boolean> {
  override rewrite(node: LogicalPlanNode, context: boolean = ORDER_REQUIRED): LogicalPlanNode {
    const orderRequired = context ?? ORDER_REQUIRED;
    const childRequirement = CHILD_ORDER_REQUIREMENT[node.type] ?? orderRequired;

    if (node.type === PlanNodeType.SORT && !orderRequired && !selectsRows(node)) {
      return this.rewrite(node.children[0], childRequirement);
    }

    const rewritten = this.rewriteChildren(node, childRequirement);
    return rewritten === node ? node : withoutSortedProperty(rewritten);
  }
}
