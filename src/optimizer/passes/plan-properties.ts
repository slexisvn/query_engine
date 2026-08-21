import { OptimizationPass } from '../pass.js';
import { PlanPropertyAnnotator } from '../../planner/plan-properties.js';
import { DefaultCardinalityEstimator, type TableStats } from '../../planner/cardinality.js';
import type { LogicalPlanNode } from '../../planner/logical-plan.js';

export const PLAN_PROPERTIES_PASS = 'PlanProperties';

export class PlanProperties extends OptimizationPass {
  annotator: PlanPropertyAnnotator;

  constructor(statisticsMap: Map<string, TableStats> = new Map(), cardEstimator: DefaultCardinalityEstimator | null = null) {
    super();
    this.annotator = new PlanPropertyAnnotator(statisticsMap, cardEstimator);
  }

  override get name() { return PLAN_PROPERTIES_PASS; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    return this.annotator.annotate(plan);
  }
}
