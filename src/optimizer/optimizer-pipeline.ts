import { Optimizer } from './optimizer.js';
import { ExpressionSimplifier } from './passes/expression-simplifier.js';
import { SubqueryUnnesting } from './passes/subquery-unnesting.js';
import { HavingPushdown } from './passes/having-pushdown.js';
import { CTEOptimization } from './passes/cte-optimization.js';
import { PredicatePushdown } from './passes/predicate-pushdown.js';
import { PredicateInference } from './passes/predicate-inference.js';
import { OuterToInnerJoin } from './passes/outer-to-inner.js';
import { AggregatePushdown } from './passes/aggregate-pushdown.js';
import { JoinReorder } from './passes/join-reorder.js';
import { JoinElimination } from './passes/join-elimination.js';
import { DistinctElimination } from './passes/distinct-elimination.js';
import { ProjectionPushdown } from './passes/projection-pushdown.js';
import { LimitPushdown } from './passes/limit-pushdown.js';
import { EmptyPropagation } from './passes/empty-propagation.js';
import { NodeMerge } from './passes/node-merge.js';
import { PredicateDedup } from './passes/predicate-dedup.js';
import { FilterOrdering } from './passes/filter-ordering.js';
import { IndexSelection } from './passes/index-selection.js';
import { JoinResidualSplit } from './passes/join-residual-split.js';
import { PlanProperties } from './passes/plan-properties.js';
import { SortElimination } from './passes/sort-elimination.js';
import { TopNFusion } from './passes/topn-fusion.js';
import type { StatsProvider, TableStats } from '../catalog/statistics.js';

export const PREDICATE_FIXPOINT_STAGE = 'PredicateOptimization';

export interface IndexCatalog {
  getIndexForColumn(table: string, column: string): object | null;
  getTable(name: string): { primaryKey: string[] } | null;
}

export interface OptimizerPipelineOptions {
  catalog: IndexCatalog;
  statistics?: Map<string, TableStats> | null;
}

export function createDefaultOptimizer({ catalog, statistics }: OptimizerPipelineOptions): Optimizer {
  const statsMap: Map<string, TableStats> = statistics ?? new Map();
  const statsProvider: StatsProvider = statsMap;

  return new Optimizer()
    .registerPass(new ExpressionSimplifier())
    .registerPass(new SubqueryUnnesting())
    .registerPass(new HavingPushdown())
    .registerPass(new CTEOptimization())
    .registerFixpoint(PREDICATE_FIXPOINT_STAGE, [
      new PredicatePushdown(),
      new PredicateInference(),
      new OuterToInnerJoin(),
    ])
    .registerPass(new AggregatePushdown())
    .registerPass(new JoinReorder(statsMap))
    .registerPass(new PredicatePushdown())
    .registerPass(new JoinElimination(catalog))
    .registerPass(new DistinctElimination(catalog))
    .registerPass(new ProjectionPushdown())
    .registerPass(new LimitPushdown())
    .registerPass(new EmptyPropagation())
    .registerPass(new NodeMerge())
    .registerPass(new PredicateDedup())
    .registerPass(new FilterOrdering(statsMap))
    .registerPass(new IndexSelection(catalog, statsProvider))
    .registerPass(new JoinResidualSplit())
    .registerPass(new PlanProperties(statsMap))
    .registerPass(new SortElimination())
    .registerPass(new TopNFusion());
}
