import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, type LogicalPlanNode, type LogicalSortNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { DefaultCardinalityEstimator, type TableStats } from '../join-order/cardinality.js';
import { columnKeyOf, inferSortOrder } from '../sort-properties.js';
import { Config } from '../../config.js';

export const PLAN_PROPERTIES_PASS = 'PlanProperties';

export class PlanProperties extends OptimizationPass {
  statisticsMap: Map<string, TableStats>;
  cardEstimator: DefaultCardinalityEstimator;

  constructor(statisticsMap: Map<string, TableStats> = new Map(), cardEstimator: DefaultCardinalityEstimator | null = null) {
    super();
    this.statisticsMap = statisticsMap;
    this.cardEstimator = cardEstimator || new DefaultCardinalityEstimator(this.statisticsMap);
  }

  override get name() { return PLAN_PROPERTIES_PASS; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    return new PlanPropertiesRewriter(this.cardEstimator).rewrite(plan);
  }
}

class PlanPropertiesRewriter extends PlanRewriter {
  cardEstimator: DefaultCardinalityEstimator;

  constructor(cardEstimator: DefaultCardinalityEstimator) {
    super();
    this.cardEstimator = cardEstimator;
  }

  override rewriteDefault(node: LogicalPlanNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    return {
      ...rewritten,
      _cardinality: this.estimateCardinality(rewritten),
      _sortedBy: inferSortOrder(rewritten),
    };
  }

  override rewriteSort(node: LogicalSortNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    const childCard = childCardinality(rewritten);

    return {
      ...rewritten,
      _cardinality: rewritten.limit ? Math.min(rewritten.limit, childCard) : childCard,
      _sortedBy: rewritten.orderKeys
        .map(key => ({ key: columnKeyOf(key.expr), direction: (key.direction || 'ASC').toUpperCase() }))
        .filter((entry): entry is { key: string; direction: string } => !!entry.key),
    };
  }

  estimateCardinality(node: LogicalPlanNode): number {
    switch (node.type) {
      case PlanNodeType.SCAN:
      case PlanNodeType.INDEX_SCAN:
        return this.cardEstimator.estimateScan(node.table);
      case PlanNodeType.FILTER:
        return this.cardEstimator.estimateFilter(childCardinality(node), node.condition);
      case PlanNodeType.JOIN:
        return this.estimateJoinCardinality(node);
      case PlanNodeType.AGGREGATE:
        return this.cardEstimator.estimateAggregate(childCardinality(node), node.groupBy?.length || 0, node.groupBy || []);
      case PlanNodeType.LIMIT:
      case PlanNodeType.TOP_N:
        return Math.min(node.count || childCardinality(node), childCardinality(node));
      case PlanNodeType.DISTINCT:
        return Math.max(1, Math.round(Math.sqrt(childCardinality(node))));
      default:
        return node.children?.length ? childCardinality(node) : Config.defaultCardinality;
    }
  }

  estimateJoinCardinality(node: LogicalPlanNode & { type: PlanNodeType.JOIN }): number {
    const leftCard = node.children[0]._cardinality ?? Config.defaultCardinality;
    const rightCard = node.children[1]._cardinality ?? Config.defaultCardinality;

    switch (node.joinType) {
      case JoinType.SEMI:
        return this.cardEstimator.estimateSemiJoin(leftCard, rightCard, node.condition);
      case JoinType.ANTI:
        return this.cardEstimator.estimateAntiJoin(leftCard, rightCard, node.condition);
      case JoinType.MARK:
        return leftCard;
      case JoinType.LEFT:
        return this.cardEstimator.estimateLeftJoin(leftCard, rightCard, node.condition);
      case JoinType.CROSS:
        return leftCard * rightCard;
      default:
        return this.cardEstimator.estimateJoin(leftCard, rightCard, node.condition);
    }
  }
}

function childCardinality(node: LogicalPlanNode): number {
  return node.children?.[0]?._cardinality ?? Config.defaultCardinality;
}
