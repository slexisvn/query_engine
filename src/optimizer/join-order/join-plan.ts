import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import type { LogicalPlanNode } from '../../planner/logical-plan.js';
import type { DefaultCostModel } from '../../planner/cost-model.js';
import { DataType } from '../../storage/data-type.js';

export interface JoinPlan {
  type: 'HashJoin';
  buildSide: LogicalPlanNode | JoinPlan;
  probeSide: LogicalPlanNode | JoinPlan;
  condition: BoundExpr | null;
  buildCard: number;
  probeCard: number;
}

export interface JoinOrderEntry {
  plan: LogicalPlanNode | JoinPlan;
  cardinality: number;
  totalCost: number;
  mask: number;
}

export interface JoinCardinalityEstimator {
  estimateJoin(leftCard: number, rightCard: number, condition: BoundExpr | null): number;
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
  predicates: BoundExpr[],
  costModel: DefaultCostModel,
  estimator: JoinCardinalityEstimator,
): JoinOrderEntry {
  const condition = combinePredicates(predicates);
  const cardinality = estimator.estimateJoin(left.cardinality, right.cardinality, condition);
  const forward = orientedJoin(left, right, condition, cardinality, costModel);
  const reversed = orientedJoin(right, left, condition, cardinality, costModel);
  return forward.totalCost <= reversed.totalCost ? forward : reversed;
}

function orientedJoin(
  build: JoinOrderEntry,
  probe: JoinOrderEntry,
  condition: BoundExpr | null,
  cardinality: number,
  costModel: DefaultCostModel,
): JoinOrderEntry {
  return {
    plan: {
      type: 'HashJoin',
      buildSide: build.plan,
      probeSide: probe.plan,
      condition,
      buildCard: build.cardinality,
      probeCard: probe.cardinality,
    },
    cardinality,
    totalCost: build.totalCost + probe.totalCost
      + costModel.hashJoinCost(build.cardinality, probe.cardinality, cardinality),
    mask: build.mask | probe.mask,
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
