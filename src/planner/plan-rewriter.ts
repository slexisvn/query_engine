import * as LP from './logical-plan.js';
import { getChildren, setChildren, PlanNodeType, type LogicalPlanNode } from './logical-plan.js';

type RewriteMethod =
  | 'rewriteScan' | 'rewriteFilter' | 'rewriteProject' | 'rewriteJoin' | 'rewriteAggregate'
  | 'rewriteSort' | 'rewriteLimit' | 'rewriteDistinct' | 'rewriteUnion' | 'rewriteCTEScan'
  | 'rewriteCTEAnchor' | 'rewriteDependentJoin' | 'rewriteMaterialize' | 'rewriteEmpty'
  | 'rewriteTopN' | 'rewriteIndexScan' | 'rewriteWindow' | 'rewriteExchange'
  | 'rewritePartialAggregate' | 'rewriteFinalAggregate' | 'rewriteMergeExchange'
  | 'rewriteExchangeReceive' | 'rewriteSingleRow';

const REWRITE_METHOD = {
  [PlanNodeType.SCAN]: 'rewriteScan',
  [PlanNodeType.FILTER]: 'rewriteFilter',
  [PlanNodeType.PROJECT]: 'rewriteProject',
  [PlanNodeType.JOIN]: 'rewriteJoin',
  [PlanNodeType.AGGREGATE]: 'rewriteAggregate',
  [PlanNodeType.SORT]: 'rewriteSort',
  [PlanNodeType.LIMIT]: 'rewriteLimit',
  [PlanNodeType.DISTINCT]: 'rewriteDistinct',
  [PlanNodeType.UNION]: 'rewriteUnion',
  [PlanNodeType.CTE_SCAN]: 'rewriteCTEScan',
  [PlanNodeType.CTE_ANCHOR]: 'rewriteCTEAnchor',
  [PlanNodeType.DEPENDENT_JOIN]: 'rewriteDependentJoin',
  [PlanNodeType.MATERIALIZE]: 'rewriteMaterialize',
  [PlanNodeType.EMPTY]: 'rewriteEmpty',
  [PlanNodeType.TOP_N]: 'rewriteTopN',
  [PlanNodeType.INDEX_SCAN]: 'rewriteIndexScan',
  [PlanNodeType.WINDOW]: 'rewriteWindow',
  [PlanNodeType.EXCHANGE]: 'rewriteExchange',
  [PlanNodeType.PARTIAL_AGGREGATE]: 'rewritePartialAggregate',
  [PlanNodeType.FINAL_AGGREGATE]: 'rewriteFinalAggregate',
  [PlanNodeType.MERGE_EXCHANGE]: 'rewriteMergeExchange',
  [PlanNodeType.EXCHANGE_RECEIVE]: 'rewriteExchangeReceive',
  [PlanNodeType.SINGLE_ROW]: 'rewriteSingleRow',
} as const satisfies Record<PlanNodeType, RewriteMethod>;

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
  rewriteUnion?(node: LP.LogicalUnionNode, context?: C): LogicalPlanNode;
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
    const handler = this[REWRITE_METHOD[node.type]] as NodeRewriteFn<C> | undefined;
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
