import { OptimizationPass } from '../../optimizer/pass.js';
import { PlanNodeType, LogicalMergeExchange, LogicalSort, getChildren, setChildren, type LogicalPlanNode, type LogicalSortNode, type LogicalTopNNode, type LogicalLimitNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';

interface DistributedFlag {
  _distributed?: boolean;
}

export class DistributedSortPass extends OptimizationPass {
  override get name(): string {
    return 'DistributedSort';
  }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    if (!(plan as LogicalPlanNode & DistributedFlag)._distributed) return plan;
    const rewriter = new DistributedSortRewriter();
    return rewriter.rewrite(plan);
  }
}

class DistributedSortRewriter extends PlanRewriter {
  override rewriteSort(node: LogicalSortNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);

    if (this._hasExchangeBelow(newNode)) {
      const localSort = LogicalSort(newNode.orderKeys, newNode.children[0]);
      localSort._cardinality = newNode._cardinality;

      const mergeExchange = LogicalMergeExchange(newNode.orderKeys, null, localSort);
      mergeExchange._cardinality = newNode._cardinality;

      return mergeExchange;
    }

    return newNode;
  }

  override rewriteTopN(node: LogicalTopNNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);

    if (this._hasExchangeBelow(newNode)) {
      const localTopN: LogicalTopNNode = {
        ...newNode,
        children: [newNode.children[0]],
      };

      const mergeExchange = LogicalMergeExchange(newNode.orderKeys, newNode.count, localTopN);
      mergeExchange._cardinality = Math.min(newNode.count || Infinity, newNode._cardinality || Infinity);

      return {
        type: PlanNodeType.LIMIT,
        count: newNode.count,
        offset: newNode.offset || 0,
        children: [mergeExchange],
      } as LogicalLimitNode;
    }

    return newNode;
  }

  _hasExchangeBelow(node: LogicalPlanNode): boolean {
    const stack: LogicalPlanNode[] = [...(node.children || [])];
    while (stack.length > 0) {
      const current = stack.pop() as LogicalPlanNode;
      if (current.type === PlanNodeType.EXCHANGE
        || current.type === PlanNodeType.PARTIAL_AGGREGATE) {
        return true;
      }
      if (current.children) {
        for (const child of current.children) {
          stack.push(child);
        }
      }
    }
    return false;
  }
}
