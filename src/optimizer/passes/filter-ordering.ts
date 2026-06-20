import { OptimizationPass } from '../pass.js';
import { PlanNodeType, type LogicalPlanNode, type LogicalFilterNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { DefaultCardinalityEstimator } from '../dphyp/cardinality.js';
import { BoundExprKind, type BoundExpr, type BoundBinaryNode } from '../../binder/expression-binder.js';

interface TableStatistics { rowCount: number; }

interface ScoredPred { pred: BoundExpr; selectivity: number; }

export class FilterOrdering extends OptimizationPass {
  cardEstimator: DefaultCardinalityEstimator;
  constructor(statisticsMap: Map<string, TableStatistics> = new Map<string, TableStatistics>()) {
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

function splitConjuncts(expr: BoundExpr | null): BoundExpr[] {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

function combineConjuncts(preds: BoundExpr[]): BoundExpr | null {
  if (preds.length === 0) return null;
  if (preds.length === 1) return preds[0];
  return preds.reduce((acc, p) => ({
    kind: BoundExprKind.BINARY,
    op: 'AND',
    left: acc,
    right: p,
    resultType: 'BOOLEAN',
  } as BoundBinaryNode));
}
