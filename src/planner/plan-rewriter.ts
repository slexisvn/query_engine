import * as LP from './logical-plan.js';
import { getChildren, setChildren, type LogicalPlanNode } from './logical-plan.js';
import { descriptorOf } from './plan-node-descriptor.js';

type NodeRewriteFn<C> = (node: LogicalPlanNode, context?: C) => LogicalPlanNode;

export class PlanRewriter<C = undefined> {
  rewriteScan?(node: LP.LogicalScanNode, context?: C): LogicalPlanNode;
  rewriteFilter?(node: LP.LogicalFilterNode, context?: C): LogicalPlanNode;
  rewriteProject?(node: LP.LogicalProjectNode, context?: C): LogicalPlanNode;
  rewriteJoin?(node: LP.LogicalJoinNode, context?: C): LogicalPlanNode;
  rewriteAggregate?(node: LP.LogicalAggregateNode, context?: C): LogicalPlanNode;
  rewriteSort?(node: LP.LogicalSortNode, context?: C): LogicalPlanNode;
  rewriteLimit?(node: LP.LogicalLimitNode, context?: C): LogicalPlanNode;
  rewriteDistinct?(node: LP.LogicalDistinctNode, context?: C): LogicalPlanNode;
  rewriteSetOp?(node: LP.LogicalSetOpNode, context?: C): LogicalPlanNode;
  rewriteCTEScan?(node: LP.LogicalCTEScanNode, context?: C): LogicalPlanNode;
  rewriteCTEAnchor?(node: LP.LogicalCTEAnchorNode, context?: C): LogicalPlanNode;
  rewriteDependentJoin?(node: LP.LogicalDependentJoinNode, context?: C): LogicalPlanNode;
  rewriteMaterialize?(node: LP.LogicalMaterializeNode, context?: C): LogicalPlanNode;
  rewriteEmpty?(node: LP.LogicalEmptyNode, context?: C): LogicalPlanNode;
  rewriteTopN?(node: LP.LogicalTopNNode, context?: C): LogicalPlanNode;
  rewriteIndexScan?(node: LP.LogicalIndexScanNode, context?: C): LogicalPlanNode;
  rewriteWindow?(node: LP.LogicalWindowNode, context?: C): LogicalPlanNode;
  rewriteExchange?(node: LP.LogicalExchangeNode, context?: C): LogicalPlanNode;
  rewritePartialAggregate?(node: LP.LogicalPartialAggregateNode, context?: C): LogicalPlanNode;
  rewriteFinalAggregate?(node: LP.LogicalFinalAggregateNode, context?: C): LogicalPlanNode;
  rewriteMergeExchange?(node: LP.LogicalMergeExchangeNode, context?: C): LogicalPlanNode;
  rewriteExchangeReceive?(node: LP.LogicalExchangeReceiveNode, context?: C): LogicalPlanNode;
  rewriteSingleRow?(node: LP.LogicalSingleRowNode, context?: C): LogicalPlanNode;

  rewrite(node: LogicalPlanNode, context?: C): LogicalPlanNode {
    const method = descriptorOf(node.type).rewriteMethod;
    const handler = (method ? this[method] : undefined) as NodeRewriteFn<C> | undefined;
    return handler ? handler.call(this, node, context) : this.rewriteDefault(node, context);
  }

  rewriteDefault(node: LogicalPlanNode, context?: C): LogicalPlanNode {
    return this.rewriteChildren(node, context);
  }

  rewriteChildren<T extends LogicalPlanNode>(node: T, context?: C): T {
    const children = getChildren(node);
    if (children.length === 0) return node;

    const newChildren = children.map(child => this.rewrite(child, context));
    const changed = newChildren.some((child, i) => child !== children[i]);
    return changed ? setChildren(node, newChildren) : node;
  }
}
