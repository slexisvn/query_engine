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

export function enumerateJoinOrder(
  graph: HyperGraph,
  costModel: DefaultCostModel,
  cardinalityEstimator: JoinCardinalityEstimator,
  options: JoinEnumerationOptions = {},
): JoinOrderEntry | null {
  const enumerator = selectJoinEnumerator(graph, costModel, cardinalityEstimator, options);
  const result = enumerator.solve();
  if (result || !enumerator.exhaustive) return result;

  return new GreedyJoinEnumerator(graph, costModel, cardinalityEstimator).solve();
}
