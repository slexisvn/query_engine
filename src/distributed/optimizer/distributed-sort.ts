import { PlanNodeType, LogicalMergeExchange, LogicalSort, type LogicalPlanNode, type LogicalSortNode, type LogicalTopNNode, type LogicalLimitNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { DistributedRewritePass } from './distributed-pass.js';

export class DistributedSortPass extends DistributedRewritePass {
  override get name(): string {
    return 'DistributedSort';
  }

  override _createRewriter(): DistributedSortRewriter {
    return new DistributedSortRewriter();
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
      const offset = newNode.offset || 0;
      const fetchCount = newNode.count + offset;
      const localTopN: LogicalTopNNode = {
        ...newNode,
        count: fetchCount,
        offset: 0,
        children: [newNode.children[0]],
      };

      const mergeExchange = LogicalMergeExchange(newNode.orderKeys, fetchCount, localTopN);
      mergeExchange._cardinality = Math.min(fetchCount || Infinity, newNode._cardinality || Infinity);

      return {
        type: PlanNodeType.LIMIT,
        count: newNode.count,
        offset,
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
