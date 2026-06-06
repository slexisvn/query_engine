import { OptimizationPass } from '../pass.js';
import { PlanNodeType } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { DefaultCardinalityEstimator } from '../dphyp/cardinality.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class FilterOrdering extends OptimizationPass {
  constructor(statisticsMap = new Map()) {
    super();
    this.cardEstimator = new DefaultCardinalityEstimator(statisticsMap);
  }

  get name() { return 'FilterOrdering'; }

  apply(plan) {
    const rewriter = new FilterOrderingRewriter(this.cardEstimator);
    return rewriter.rewrite(plan);
  }
}

class FilterOrderingRewriter extends PlanRewriter {
  constructor(cardEstimator) {
    super();
    this.cardEstimator = cardEstimator;
  }

  rewriteFilter(node) {
    const rewritten = this.rewriteChildren(node);
    const conjuncts = splitConjuncts(rewritten.condition);
    if (conjuncts.length < 2) return rewritten;

    const scored = conjuncts.map(pred => ({
      pred,
      selectivity: this.cardEstimator.estimateSelectivity(pred),
    }));

    scored.sort((a, b) => a.selectivity - b.selectivity);

    const reordered = combineConjuncts(scored.map(s => s.pred));
    return { ...rewritten, condition: reordered };
  }
}

function splitConjuncts(expr) {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

function combineConjuncts(preds) {
  if (preds.length === 0) return null;
  if (preds.length === 1) return preds[0];
  return preds.reduce((acc, p) => ({
    kind: BoundExprKind.BINARY,
    op: 'AND',
    left: acc,
    right: p,
    resultType: 'BOOLEAN',
  }));
}
