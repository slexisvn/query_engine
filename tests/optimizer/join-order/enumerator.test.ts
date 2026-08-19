import { describe, it, expect } from 'vitest';
import { enumerateJoinOrder, selectJoinEnumerator } from '../../../src/optimizer/join-order/enumerator.js';
import { DPhypEnumerator } from '../../../src/optimizer/join-order/dphyp.js';
import { GreedyJoinEnumerator } from '../../../src/optimizer/join-order/greedy.js';
import { DefaultCostModel } from '../../../src/optimizer/join-order/cost-model.js';
import { Config } from '../../../src/config.js';
import {
  buildGraph,
  chainEdges,
  cliqueEdges,
  proportionalEstimator,
} from '../../helpers/join-graphs.js';

const costModel = new DefaultCostModel();

function chainGraph(size) {
  return buildGraph(Array.from({ length: size }, (_, i) => (i + 1) * 100), chainEdges(size));
}

describe('selectJoinEnumerator', () => {
  it('picks the exhaustive enumerator at the relation limit', () => {
    const graph = chainGraph(Config.joinOrderDpMaxRelations);
    expect(selectJoinEnumerator(graph, costModel, proportionalEstimator())).toBeInstanceOf(DPhypEnumerator);
  });

  it('picks the greedy enumerator one relation past the limit', () => {
    const graph = chainGraph(Config.joinOrderDpMaxRelations + 1);
    expect(selectJoinEnumerator(graph, costModel, proportionalEstimator())).toBeInstanceOf(GreedyJoinEnumerator);
  });

  it('honours an explicit relation limit override', () => {
    const graph = chainGraph(5);
    expect(selectJoinEnumerator(graph, costModel, proportionalEstimator(), { dpMaxRelations: 4 }))
      .toBeInstanceOf(GreedyJoinEnumerator);
    expect(selectJoinEnumerator(graph, costModel, proportionalEstimator(), { dpMaxRelations: 5 }))
      .toBeInstanceOf(DPhypEnumerator);
  });

  it('passes the pair budget through to the exhaustive enumerator', () => {
    const enumerator = selectJoinEnumerator(chainGraph(4), costModel, proportionalEstimator(), { pairBudget: 3 });
    expect(enumerator.pairBudget).toBe(3);
  });
});

describe('enumerateJoinOrder', () => {
  it('returns the exhaustive optimum when the graph fits the limit', () => {
    const graph = chainGraph(5);
    const direct = new DPhypEnumerator(chainGraph(5), costModel, proportionalEstimator()).solve();
    const dispatched = enumerateJoinOrder(graph, costModel, proportionalEstimator());

    expect(dispatched.totalCost).toBeCloseTo(direct.totalCost, 6);
  });

  it('still produces a full plan past the relation limit', () => {
    const size = Config.joinOrderDpMaxRelations + 6;
    const graph = chainGraph(size);
    const result = enumerateJoinOrder(graph, costModel, proportionalEstimator());

    expect(result).not.toBeNull();
    expect(result.mask).toBe(graph.fullMask);
  });

  it('falls back to greedy when the pair budget is exhausted', () => {
    const graph = buildGraph(Array.from({ length: 7 }, () => 1000), cliqueEdges(7));
    const result = enumerateJoinOrder(graph, costModel, proportionalEstimator(), { pairBudget: 3 });

    expect(result).not.toBeNull();
    expect(result.mask).toBe(graph.fullMask);
  });

  it('returns null when neither strategy can connect the graph', () => {
    const graph = buildGraph([100, 200, 300, 400], [[0, 1], [2, 3]]);
    expect(enumerateJoinOrder(graph, costModel, proportionalEstimator())).toBeNull();
  });

  it('completes a wide chain well past the exhaustive limit without exploding', () => {
    const graph = chainGraph(26);
    const started = Date.now();
    const result = enumerateJoinOrder(graph, costModel, proportionalEstimator());

    expect(result.mask).toBe(graph.fullMask);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('completes a wide clique past the exhaustive limit without exploding', () => {
    const size = Config.joinOrderDpMaxRelations + 8;
    const graph = buildGraph(Array.from({ length: size }, () => 1000), cliqueEdges(size));
    const started = Date.now();
    const result = enumerateJoinOrder(graph, costModel, proportionalEstimator());

    expect(result).not.toBeNull();
    expect(result.mask).toBe(graph.fullMask);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
