import { OptimizationPass } from '../pass.js';
import { PlanNodeType, type LogicalPlanNode, type LogicalFilterNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { DefaultCardinalityEstimator, type TableStats } from '../join-order/cardinality.js';
import { type BoundExpr } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';

interface ScoredPred { pred: BoundExpr; selectivity: number; }

export class FilterOrdering extends OptimizationPass {
  cardEstimator: DefaultCardinalityEstimator;
  constructor(statisticsMap: Map<string, TableStats> = new Map<string, TableStats>()) {
    super();
    this.cardEstimator = new DefaultCardinalityEstimator(statisticsMap);
  }

  override get name() { return 'FilterOrdering'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new FilterOrderingRewriter(this.cardEstimator);
    return rewriter.rewrite(plan);
  }
}

class FilterOrderingRewriter extends PlanRewriter {
  cardEstimator: DefaultCardinalityEstimator;
  constructor(cardEstimator: DefaultCardinalityEstimator) {
    super();
    this.cardEstimator = cardEstimator;
  }

  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    const conjuncts = splitConjuncts(rewritten.condition);
    if (conjuncts.length < 2) return rewritten;

    const scored: ScoredPred[] = conjuncts.map((pred) => ({
      pred,
      selectivity: this.cardEstimator.estimateSelectivity(pred),
    }));

    scored.sort((a, b) => a.selectivity - b.selectivity);

    const reordered = combineConjuncts(scored.map((s) => s.pred));
    return { ...rewritten, condition: reordered };
  }
}
