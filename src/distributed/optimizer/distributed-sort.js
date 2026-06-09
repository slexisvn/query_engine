import { OptimizationPass } from '../../optimizer/pass.js';
import { PlanNodeType, LogicalMergeExchange, LogicalSort, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';

export class DistributedSortPass extends OptimizationPass {
  get name() {
    return 'DistributedSort';
  }

  apply(plan) {
    if (!plan._distributed) return plan;
    const rewriter = new DistributedSortRewriter();
    return rewriter.rewrite(plan);
  }
}

class DistributedSortRewriter extends PlanRewriter {
  rewriteSort(node) {
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

  rewriteTopN(node) {
    const newNode = this.rewriteChildren(node);

    if (this._hasExchangeBelow(newNode)) {
      const localTopN = {
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
      };
    }

    return newNode;
  }

  _hasExchangeBelow(node) {
    const stack = [...(node.children || [])];
    while (stack.length > 0) {
      const current = stack.pop();
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
