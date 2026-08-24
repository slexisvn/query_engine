import { type LogicalPlanNode } from './logical-plan.js';
import { PlanRewriter } from './plan-rewriter.js';
import { DefaultCardinalityEstimator, estimateNodeCardinality, type TableStats } from './cardinality.js';
import { inferSortOrder } from './sort-properties.js';
import { Config } from '../config.js';

export class PlanPropertyAnnotator {
  statisticsMap: Map<string, TableStats>;
  cardEstimator: DefaultCardinalityEstimator;

  constructor(statisticsMap: Map<string, TableStats> = new Map(), cardEstimator: DefaultCardinalityEstimator | null = null) {
    this.statisticsMap = statisticsMap;
    this.cardEstimator = cardEstimator || new DefaultCardinalityEstimator(this.statisticsMap);
  }

  annotate(plan: LogicalPlanNode): LogicalPlanNode {
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

  estimateCardinality(node: LogicalPlanNode): number {
    const inputs = (node.children ?? []).map(child => child._cardinality ?? Config.defaultCardinality);
    return estimateNodeCardinality(this.cardEstimator, node, inputs);
  }
}
