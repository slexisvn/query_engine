import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import { JoinType, type LogicalJoinNode, type LogicalPlanNode } from '../../planner/logical-plan.js';
import type { DefaultCostModel } from '../../planner/cost-model.js';
import { DataType } from '../../storage/data-type.js';
import { JOIN_TYPE_PROPERTIES } from './join-conflicts.js';
import type { JoinResolution } from './hypergraph.js';

export interface JoinPlan {
  type: 'HashJoin';
  joinType: JoinType;
  source: LogicalJoinNode | null;
  leftSide: LogicalPlanNode | JoinPlan;
  rightSide: LogicalPlanNode | JoinPlan;
  condition: BoundExpr | null;
  leftCard: number;
  rightCard: number;
}

export interface JoinOrderEntry {
  plan: LogicalPlanNode | JoinPlan;
  cardinality: number;
  totalCost: number;
  mask: number;
}

export interface JoinCardinalityEstimator {
  estimateJoinOf(joinType: JoinType, leftCard: number, rightCard: number, condition: BoundExpr | null): number;
}

export interface JoinEnumerator {
  readonly name: string;
  readonly exhaustive: boolean;
  solve(): JoinOrderEntry | null;
}

export function combinePredicates(preds: BoundExpr[]): BoundExpr | null {
  if (preds.length === 0) return null;
  if (preds.length === 1) return preds[0];

  const unique: BoundExpr[] = [];
  const seen = new Set<string>();
  for (const p of preds) {
    const key = predicateKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  if (unique.length === 1) return unique[0];
  return unique.reduce((acc, p) => ({
    kind: BoundExprKind.BINARY,
    op: 'AND',
    left: acc,
    right: p,
    resultType: DataType.BOOLEAN,
  }));
}

export function bestJoinOf(
  left: JoinOrderEntry,
  right: JoinOrderEntry,
  resolution: JoinResolution,
  costModel: DefaultCostModel,
  estimator: JoinCardinalityEstimator,
): JoinOrderEntry {
  const condition = combinePredicates(resolution.predicates);
  const outer = resolution.swapped ? right : left;
  const inner = resolution.swapped ? left : right;
  const cardinality = estimator.estimateJoinOf(resolution.joinType, outer.cardinality, inner.cardinality, condition);

  const forward = orientedJoin(resolution, outer, inner, condition, cardinality, costModel);
  if (!JOIN_TYPE_PROPERTIES[resolution.joinType].commutative) return forward;

  const reversed = orientedJoin(resolution, inner, outer, condition, cardinality, costModel);
  return forward.totalCost <= reversed.totalCost ? forward : reversed;
}

function orientedJoin(
  resolution: JoinResolution,
  leftSide: JoinOrderEntry,
  rightSide: JoinOrderEntry,
  condition: BoundExpr | null,
  cardinality: number,
  costModel: DefaultCostModel,
): JoinOrderEntry {
  return {
    plan: {
      type: 'HashJoin',
      joinType: resolution.joinType,
      source: resolution.source,
      leftSide: leftSide.plan,
      rightSide: rightSide.plan,
      condition,
      leftCard: leftSide.cardinality,
      rightCard: rightSide.cardinality,
    },
    cardinality,
    totalCost: leftSide.totalCost + rightSide.totalCost
      + costModel.hashJoinCost(leftSide.cardinality, rightSide.cardinality, cardinality),
    mask: leftSide.mask | rightSide.mask,
  };
}

function predicateKey(pred: BoundExpr | null): string {
  if (!pred) return '';
  if (pred.kind === BoundExprKind.COLUMN_REF) {
    return `${pred.tableAlias}.${pred.columnName}`;
  }
  if (pred.kind === BoundExprKind.BINARY) {
    return `${predicateKey(pred.left)}${pred.op}${predicateKey(pred.right)}`;
  }
  if (pred.kind === BoundExprKind.LITERAL) {
    return String(pred.value);
  }
  return JSON.stringify(pred);
}
