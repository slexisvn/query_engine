import { BoundExprKind, type BoundExpr } from '../binder/expression-binder.js';
import { toNumericValue } from '../storage/data-type.js';
import { DefaultCardinalityEstimator } from './cardinality.js';
import type { LogicalAggregateNode, LogicalPlanNode } from './logical-plan.js';
import type { ColumnStats, StatsProvider } from '../catalog/statistics.js';

export type AggregateStatsProvider = StatsProvider;

const MAX_PERFECT_HASH_GROUPS = 256;
const MAX_PERFECT_HASH_DOMAIN = 4096;
const MAX_LOW_CARDINALITY_NDV = 4;

export function hasCompactDomain(stats: ColumnStats): boolean {
  const ndv = stats.ndv || 0;
  if (ndv <= 0 || ndv > MAX_PERFECT_HASH_GROUPS) return false;

  const min = toNumericValue(stats.min);
  const max = toNumericValue(stats.max);
  if (min !== null && max !== null && Number.isInteger(min) && Number.isInteger(max)) {
    const domainSize = max - min + 1;
    return domainSize > 0 && domainSize <= MAX_PERFECT_HASH_DOMAIN;
  }

  return ndv <= MAX_LOW_CARDINALITY_NDV;
}

export function canUsePerfectHashAggregate(
  node: LogicalAggregateNode,
  child: LogicalPlanNode,
  statistics: AggregateStatsProvider,
): boolean {
  if (!node.groupBy || node.groupBy.length === 0) return false;
  if (!node.groupBy.every((expr: BoundExpr) => expr.kind === BoundExprKind.COLUMN_REF)) return false;

  const estimator = new DefaultCardinalityEstimator(statistics);
  const keyStats = node.groupBy.map((expr: BoundExpr) => estimator.getColumnStats(expr));
  if (!keyStats.every((stats): stats is ColumnStats => !!stats)) return false;

  let totalGroups = 1;
  for (const stats of keyStats) {
    if (!stats.ndv || stats.ndv <= 0) return false;
    totalGroups *= stats.ndv;
  }
  if (totalGroups > MAX_PERFECT_HASH_GROUPS) return false;

  return keyStats.every(hasCompactDomain);
}
