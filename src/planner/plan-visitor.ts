import * as LP from './logical-plan.js';
import { getChildren, setChildren, PlanNodeType, type LogicalPlanNode } from './logical-plan.js';

export class PlanVisitor {
  visitScan?(node: LP.LogicalScanNode): void;
  visitFilter?(node: LP.LogicalFilterNode): void;
  visitProject?(node: LP.LogicalProjectNode): void;
  visitJoin?(node: LP.LogicalJoinNode): void;
  visitAggregate?(node: LP.LogicalAggregateNode): void;
  visitSort?(node: LP.LogicalSortNode): void;
  visitLimit?(node: LP.LogicalLimitNode): void;
  visitDistinct?(node: LP.LogicalDistinctNode): void;
  visitUnion?(node: LP.LogicalUnionNode): void;
  visitCTEScan?(node: LP.LogicalCTEScanNode): void;
  visitCTEAnchor?(node: LP.LogicalCTEAnchorNode): void;
  visitDependentJoin?(node: LP.LogicalDependentJoinNode): void;
  visitMaterialize?(node: LP.LogicalMaterializeNode): void;
  visitEmpty?(node: LP.LogicalEmptyNode): void;
  visitTopN?(node: LP.LogicalTopNNode): void;
  visitIndexScan?(node: LP.LogicalIndexScanNode): void;
  visitWindow?(node: LP.LogicalWindowNode): void;
  visitExchange?(node: LP.LogicalExchangeNode): void;
  visitPartialAggregate?(node: LP.LogicalPartialAggregateNode): void;
  visitFinalAggregate?(node: LP.LogicalFinalAggregateNode): void;
  visitMergeExchange?(node: LP.LogicalMergeExchangeNode): void;
  visitExchangeReceive?(node: LP.LogicalExchangeReceiveNode): void;
  visitSingleRow?(node: LP.LogicalSingleRowNode): void;

  visit(node: LogicalPlanNode): void {
    switch (node.type) {
      case PlanNodeType.SCAN: return this.visitScan ? this.visitScan(node) : this.visitDefault(node);
      case PlanNodeType.FILTER: return this.visitFilter ? this.visitFilter(node) : this.visitDefault(node);
      case PlanNodeType.PROJECT: return this.visitProject ? this.visitProject(node) : this.visitDefault(node);
      case PlanNodeType.JOIN: return this.visitJoin ? this.visitJoin(node) : this.visitDefault(node);
      case PlanNodeType.AGGREGATE: return this.visitAggregate ? this.visitAggregate(node) : this.visitDefault(node);
      case PlanNodeType.SORT: return this.visitSort ? this.visitSort(node) : this.visitDefault(node);
      case PlanNodeType.LIMIT: return this.visitLimit ? this.visitLimit(node) : this.visitDefault(node);
      case PlanNodeType.DISTINCT: return this.visitDistinct ? this.visitDistinct(node) : this.visitDefault(node);
      case PlanNodeType.UNION: return this.visitUnion ? this.visitUnion(node) : this.visitDefault(node);
      case PlanNodeType.CTE_SCAN: return this.visitCTEScan ? this.visitCTEScan(node) : this.visitDefault(node);
      case PlanNodeType.CTE_ANCHOR: return this.visitCTEAnchor ? this.visitCTEAnchor(node) : this.visitDefault(node);
      case PlanNodeType.DEPENDENT_JOIN: return this.visitDependentJoin ? this.visitDependentJoin(node) : this.visitDefault(node);
      case PlanNodeType.MATERIALIZE: return this.visitMaterialize ? this.visitMaterialize(node) : this.visitDefault(node);
      case PlanNodeType.EMPTY: return this.visitEmpty ? this.visitEmpty(node) : this.visitDefault(node);
      case PlanNodeType.TOP_N: return this.visitTopN ? this.visitTopN(node) : this.visitDefault(node);
      case PlanNodeType.INDEX_SCAN: return this.visitIndexScan ? this.visitIndexScan(node) : this.visitDefault(node);
      case PlanNodeType.WINDOW: return this.visitWindow ? this.visitWindow(node) : this.visitDefault(node);
      case PlanNodeType.EXCHANGE: return this.visitExchange ? this.visitExchange(node) : this.visitDefault(node);
      case PlanNodeType.PARTIAL_AGGREGATE: return this.visitPartialAggregate ? this.visitPartialAggregate(node) : this.visitDefault(node);
      case PlanNodeType.FINAL_AGGREGATE: return this.visitFinalAggregate ? this.visitFinalAggregate(node) : this.visitDefault(node);
      case PlanNodeType.MERGE_EXCHANGE: return this.visitMergeExchange ? this.visitMergeExchange(node) : this.visitDefault(node);
      case PlanNodeType.EXCHANGE_RECEIVE: return this.visitExchangeReceive ? this.visitExchangeReceive(node) : this.visitDefault(node);
      case PlanNodeType.SINGLE_ROW: return this.visitSingleRow ? this.visitSingleRow(node) : this.visitDefault(node);
      default: return this.visitDefault(node);
    }
  }

  visitDefault(node: LogicalPlanNode): void {
    this.visitChildren(node);
  }

  visitChildren(node: LogicalPlanNode): void {
    for (const child of getChildren(node)) {
      this.visit(child);
    }
  }
}

export class PlanRewriter {
  rewriteScan?(node: LP.LogicalScanNode): LogicalPlanNode;
  rewriteFilter?(node: LP.LogicalFilterNode): LogicalPlanNode;
  rewriteProject?(node: LP.LogicalProjectNode): LogicalPlanNode;
  rewriteJoin?(node: LP.LogicalJoinNode): LogicalPlanNode;
  rewriteAggregate?(node: LP.LogicalAggregateNode): LogicalPlanNode;
  rewriteSort?(node: LP.LogicalSortNode): LogicalPlanNode;
  rewriteLimit?(node: LP.LogicalLimitNode): LogicalPlanNode;
  rewriteDistinct?(node: LP.LogicalDistinctNode): LogicalPlanNode;
  rewriteUnion?(node: LP.LogicalUnionNode): LogicalPlanNode;
  rewriteCTEScan?(node: LP.LogicalCTEScanNode): LogicalPlanNode;
  rewriteCTEAnchor?(node: LP.LogicalCTEAnchorNode): LogicalPlanNode;
  rewriteDependentJoin?(node: LP.LogicalDependentJoinNode): LogicalPlanNode;
  rewriteMaterialize?(node: LP.LogicalMaterializeNode): LogicalPlanNode;
  rewriteEmpty?(node: LP.LogicalEmptyNode): LogicalPlanNode;
  rewriteTopN?(node: LP.LogicalTopNNode): LogicalPlanNode;
  rewriteIndexScan?(node: LP.LogicalIndexScanNode): LogicalPlanNode;
  rewriteWindow?(node: LP.LogicalWindowNode): LogicalPlanNode;
  rewriteExchange?(node: LP.LogicalExchangeNode): LogicalPlanNode;
  rewritePartialAggregate?(node: LP.LogicalPartialAggregateNode): LogicalPlanNode;
  rewriteFinalAggregate?(node: LP.LogicalFinalAggregateNode): LogicalPlanNode;
  rewriteMergeExchange?(node: LP.LogicalMergeExchangeNode): LogicalPlanNode;
  rewriteExchangeReceive?(node: LP.LogicalExchangeReceiveNode): LogicalPlanNode;
  rewriteSingleRow?(node: LP.LogicalSingleRowNode): LogicalPlanNode;

  rewrite(node: LogicalPlanNode): LogicalPlanNode {
    switch (node.type) {
      case PlanNodeType.SCAN: return this.rewriteScan ? this.rewriteScan(node) : this.rewriteDefault(node);
      case PlanNodeType.FILTER: return this.rewriteFilter ? this.rewriteFilter(node) : this.rewriteDefault(node);
      case PlanNodeType.PROJECT: return this.rewriteProject ? this.rewriteProject(node) : this.rewriteDefault(node);
      case PlanNodeType.JOIN: return this.rewriteJoin ? this.rewriteJoin(node) : this.rewriteDefault(node);
      case PlanNodeType.AGGREGATE: return this.rewriteAggregate ? this.rewriteAggregate(node) : this.rewriteDefault(node);
      case PlanNodeType.SORT: return this.rewriteSort ? this.rewriteSort(node) : this.rewriteDefault(node);
      case PlanNodeType.LIMIT: return this.rewriteLimit ? this.rewriteLimit(node) : this.rewriteDefault(node);
      case PlanNodeType.DISTINCT: return this.rewriteDistinct ? this.rewriteDistinct(node) : this.rewriteDefault(node);
      case PlanNodeType.UNION: return this.rewriteUnion ? this.rewriteUnion(node) : this.rewriteDefault(node);
      case PlanNodeType.CTE_SCAN: return this.rewriteCTEScan ? this.rewriteCTEScan(node) : this.rewriteDefault(node);
      case PlanNodeType.CTE_ANCHOR: return this.rewriteCTEAnchor ? this.rewriteCTEAnchor(node) : this.rewriteDefault(node);
      case PlanNodeType.DEPENDENT_JOIN: return this.rewriteDependentJoin ? this.rewriteDependentJoin(node) : this.rewriteDefault(node);
      case PlanNodeType.MATERIALIZE: return this.rewriteMaterialize ? this.rewriteMaterialize(node) : this.rewriteDefault(node);
      case PlanNodeType.EMPTY: return this.rewriteEmpty ? this.rewriteEmpty(node) : this.rewriteDefault(node);
      case PlanNodeType.TOP_N: return this.rewriteTopN ? this.rewriteTopN(node) : this.rewriteDefault(node);
      case PlanNodeType.INDEX_SCAN: return this.rewriteIndexScan ? this.rewriteIndexScan(node) : this.rewriteDefault(node);
      case PlanNodeType.WINDOW: return this.rewriteWindow ? this.rewriteWindow(node) : this.rewriteDefault(node);
      case PlanNodeType.EXCHANGE: return this.rewriteExchange ? this.rewriteExchange(node) : this.rewriteDefault(node);
      case PlanNodeType.PARTIAL_AGGREGATE: return this.rewritePartialAggregate ? this.rewritePartialAggregate(node) : this.rewriteDefault(node);
      case PlanNodeType.FINAL_AGGREGATE: return this.rewriteFinalAggregate ? this.rewriteFinalAggregate(node) : this.rewriteDefault(node);
      case PlanNodeType.MERGE_EXCHANGE: return this.rewriteMergeExchange ? this.rewriteMergeExchange(node) : this.rewriteDefault(node);
      case PlanNodeType.EXCHANGE_RECEIVE: return this.rewriteExchangeReceive ? this.rewriteExchangeReceive(node) : this.rewriteDefault(node);
      case PlanNodeType.SINGLE_ROW: return this.rewriteSingleRow ? this.rewriteSingleRow(node) : this.rewriteDefault(node);
      default: return this.rewriteDefault(node);
    }
  }

  rewriteDefault(node: LogicalPlanNode): LogicalPlanNode {
    return this.rewriteChildren(node);
  }

  rewriteChildren<T extends LogicalPlanNode>(node: T): T {
    const children = getChildren(node);
    if (children.length === 0) return node;

    const newChildren = children.map(child => this.rewrite(child));
    const changed = newChildren.some((child, i) => child !== children[i]);
    return changed ? setChildren(node, newChildren) : node;
  }
}
