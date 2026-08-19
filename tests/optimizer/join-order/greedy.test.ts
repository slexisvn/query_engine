import { describe, it, expect } from 'vitest';
import { GreedyJoinEnumerator } from '../../../src/optimizer/join-order/greedy.js';
import { DPhypEnumerator } from '../../../src/optimizer/join-order/dphyp.js';
import { DefaultCostModel } from '../../../src/optimizer/join-order/cost-model.js';
import { HyperGraph } from '../../../src/optimizer/join-order/hypergraph.js';
import {
  buildGraph,
  chainEdges,
  starEdges,
  cliqueEdges,
  cycleEdges,
  proportionalEstimator,
  seededRandom,
} from '../../helpers/join-graphs.js';

function collectLeafCardinalities(plan, out = []) {
  if (plan.type === 'HashJoin') {
    collectLeafCardinalities(plan.buildSide, out);
    collectLeafCardinalities(plan.probeSide, out);
    return out;
  }
  out.push(plan.table);
  return out;
}

describe('GreedyJoinEnumerator', () => {
  const costModel = new DefaultCostModel();

  describe('coverage', () => {
    it('covers every relation of a chain', () => {
      const graph = buildGraph([100, 200, 300, 400, 500], chainEdges(5));
      const result = new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve();

      expect(result).not.toBeNull();
      expect(result.mask).toBe(graph.fullMask);
      expect(collectLeafCardinalities(result.plan)).toHaveLength(5);
    });

    it('covers every relation of a star', () => {
      const graph = buildGraph([1000000, 10, 20, 30, 40, 50], starEdges(6));
      const result = new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve();

      expect(result.mask).toBe(graph.fullMask);
    });

    it('covers every relation of a cycle', () => {
      const graph = buildGraph([100, 200, 300, 400], cycleEdges(4));
      const result = new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve();

      expect(result.mask).toBe(graph.fullMask);
    });

    it('covers relation counts far beyond the exhaustive search limit', () => {
      const size = 25;
      const graph = buildGraph(Array.from({ length: size }, (_, i) => (i + 1) * 100), chainEdges(size));
      const result = new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve();

      expect(result).not.toBeNull();
      expect(result.mask).toBe(graph.fullMask);
      expect(collectLeafCardinalities(result.plan)).toHaveLength(size);
    });
  });

  describe('disconnected input', () => {
    it('returns null when the graph has no edges', () => {
      const graph = buildGraph([100, 200], []);
      expect(new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve()).toBeNull();
    });

    it('returns null when two components cannot be joined', () => {
      const graph = buildGraph([100, 200, 300, 400], [[0, 1], [2, 3]]);
      expect(new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve()).toBeNull();
    });

    it('returns the single relation entry when only one exists', () => {
      const graph = buildGraph([100], []);
      const result = new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve();

      expect(result).not.toBeNull();
      expect(result.cardinality).toBe(100);
    });
  });

  describe('plan quality', () => {
    it('joins the smallest intermediate result first on a star', () => {
      const graph = buildGraph([1000000, 5, 5000], starEdges(3));
      const result = new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve();

      const innerJoin = [result.plan.buildSide, result.plan.probeSide].find(side => side.type === 'HashJoin');
      const innerLeaves = collectLeafCardinalities(innerJoin);
      expect(innerLeaves).toContain('A');
      expect(innerLeaves).toContain('B');
    });

    it('stays within a bounded factor of the exhaustive optimum on random graphs', () => {
      const estimator = proportionalEstimator();

      for (let seed = 1; seed <= 20; seed++) {
        const random = seededRandom(seed * 7);
        const size = 4 + (seed % 4);
        const cardinalities = Array.from({ length: size }, () => 10 + Math.floor(random() * 20000));
        const edges = chainEdges(size);

        const optimal = new DPhypEnumerator(buildGraph(cardinalities, edges), costModel, estimator).solve();
        const greedy = new GreedyJoinEnumerator(buildGraph(cardinalities, edges), costModel, estimator).solve();

        expect(greedy, `seed ${seed}`).not.toBeNull();
        expect(greedy.totalCost, `seed ${seed}`).toBeGreaterThanOrEqual(optimal.totalCost - 1e-6);
      }
    });

    it('reaches the exhaustive optimum on a three-relation chain', () => {
      const cardinalities = [10, 100000, 10];
      const estimator = proportionalEstimator();

      const optimal = new DPhypEnumerator(buildGraph(cardinalities, chainEdges(3)), costModel, estimator).solve();
      const greedy = new GreedyJoinEnumerator(buildGraph(cardinalities, chainEdges(3)), costModel, estimator).solve();

      expect(greedy.totalCost).toBeCloseTo(optimal.totalCost, 6);
    });
  });

  describe('hyperedges spanning several relations', () => {
    it('defers a hyperedge until one side lives in a single subplan', () => {
      const graph = new HyperGraph();
      graph.addRelation('A', { type: 'Scan', table: 'A' }, 100);
      graph.addRelation('B', { type: 'Scan', table: 'B' }, 100);
      graph.addRelation('C', { type: 'Scan', table: 'C' }, 100);
      graph.addEdge(['A'], ['B'], { kind: 'binary' });
      graph.addEdge(['A', 'B'], ['C'], { kind: 'binary' });

      const result = new GreedyJoinEnumerator(graph, costModel, proportionalEstimator()).solve();

      expect(result).not.toBeNull();
      expect(result.mask).toBe(graph.fullMask);
    });
  });

  describe('identity', () => {
    it('reports a name distinct from the exhaustive enumerator', () => {
      const graph = buildGraph([1, 2], chainEdges(2));
      const greedy = new GreedyJoinEnumerator(graph, costModel, proportionalEstimator());
      const exhaustive = new DPhypEnumerator(graph, costModel, proportionalEstimator());

      expect(greedy.name).not.toBe(exhaustive.name);
    });
  });
});
