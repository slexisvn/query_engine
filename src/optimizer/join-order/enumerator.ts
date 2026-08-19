import { DPhypEnumerator } from './dphyp.js';
import { GreedyJoinEnumerator } from './greedy.js';
import { Config } from '../../config.js';
import type { HyperGraph } from './hypergraph.js';
import type { DefaultCostModel } from './cost-model.js';
import type { JoinCardinalityEstimator, JoinEnumerator, JoinOrderEntry } from './join-plan.js';

export interface JoinEnumerationOptions {
  dpMaxRelations?: number;
  pairBudget?: number;
}

export function enumerateJoinOrder(
  graph: HyperGraph,
  costModel: DefaultCostModel,
  cardinalityEstimator: JoinCardinalityEstimator,
  options: JoinEnumerationOptions = {},
): JoinOrderEntry | null {
  const dpMaxRelations = options.dpMaxRelations ?? Config.joinOrderDpMaxRelations;
  const pairBudget = options.pairBudget ?? Config.joinOrderMaxPairs;

  if (graph.size <= dpMaxRelations) {
    const exhaustive = new DPhypEnumerator(graph, costModel, cardinalityEstimator, pairBudget);
    const optimal = exhaustive.solve();
    if (optimal) return optimal;
  }

  return new GreedyJoinEnumerator(graph, costModel, cardinalityEstimator).solve();
}

export function selectJoinEnumerator(
  graph: HyperGraph,
  costModel: DefaultCostModel,
  cardinalityEstimator: JoinCardinalityEstimator,
  options: JoinEnumerationOptions = {},
): JoinEnumerator {
  const dpMaxRelations = options.dpMaxRelations ?? Config.joinOrderDpMaxRelations;
  return graph.size <= dpMaxRelations
    ? new DPhypEnumerator(graph, costModel, cardinalityEstimator, options.pairBudget ?? Config.joinOrderMaxPairs)
    : new GreedyJoinEnumerator(graph, costModel, cardinalityEstimator);
}
