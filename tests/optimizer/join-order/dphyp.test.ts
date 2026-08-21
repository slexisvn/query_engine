import { describe, it, expect } from 'vitest';
import { DPhypEnumerator } from '../../../src/optimizer/join-order/dphyp.js';
import { HyperGraph } from '../../../src/optimizer/join-order/hypergraph.js';
import { DefaultCostModel } from '../../../src/planner/cost-model.js';
import {
  makeEqPred,
  buildGraph,
  chainEdges,
  starEdges,
  cycleEdges,
  cliqueEdges,
  relationName,
  proportionalEstimator,
  seededRandom,
  bruteForceOptimum,
} from '../../helpers/join-graphs.js';

function simpleEstimator() {
  return {
    estimateJoin(leftCard, rightCard, condition) {
      if (!condition) return leftCard * rightCard;
      return Math.max(1, Math.round(Math.max(leftCard, rightCard)));
    },
  };
}

function buildChainGraph(sizes) {
  return buildGraph(sizes, chainEdges(sizes.length));
}

function randomConnectedEdges(size, random) {
  const edges = [];
  for (let i = 1; i < size; i++) {
    edges.push([Math.floor(random() * i), i]);
  }
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      if (random() < 0.25) edges.push([i, j]);
    }
  }
  return edges;
}

describe('DPhypEnumerator', () => {
  describe('two-relation join', () => {
    it('produces a join plan covering both relations', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
      g.addRelation('B', { type: 'Scan', table: 'B' }, 200);
      g.addEdge(['A'], ['B'], makeEqPred('A', 'id', 'B', 'a_id'));

      const cost = new DefaultCostModel();
      const result = new DPhypEnumerator(g, cost, simpleEstimator()).solve();

      expect(result).not.toBeNull();
      expect(result.mask).toBe(0b11);
      expect(result.plan.type).toBe('HashJoin');
    });

    it('puts smaller relation on build side', () => {
      const g = new HyperGraph();
      g.addRelation('Small', { type: 'Scan', table: 'Small' }, 10);
      g.addRelation('Big', { type: 'Scan', table: 'Big' }, 10000);
      g.addEdge(['Small'], ['Big'], makeEqPred('Small', 'id', 'Big', 's_id'));

      const cost = new DefaultCostModel();
      const result = new DPhypEnumerator(g, cost, simpleEstimator()).solve();

      expect(result.plan.buildSide.table).toBe('Small');
      expect(result.plan.probeSide.table).toBe('Big');
    });
  });

  describe('three-relation chain (A-B-C)', () => {
    it('finds a plan covering all three relations', () => {
      const g = buildChainGraph([100, 200, 50]);
      const result = new DPhypEnumerator(g, new DefaultCostModel(), simpleEstimator()).solve();

      expect(result).not.toBeNull();
      expect(result.mask).toBe(0b111);
    });

    it('joins cheapest pair first', () => {
      const g = buildChainGraph([1000, 10, 1000]);
      const result = new DPhypEnumerator(g, new DefaultCostModel(), simpleEstimator()).solve();

      expect(result).not.toBeNull();
      const plan = result.plan;
      expect(plan.type).toBe('HashJoin');
      const innerJoin = [plan.buildSide, plan.probeSide].find(s => s.type === 'HashJoin');
      expect(innerJoin).toBeDefined();
    });
  });

  describe('star schema (fact + dimensions)', () => {
    it('joins all tables in a star', () => {
      const g = new HyperGraph();
      g.addRelation('Fact', { type: 'Scan', table: 'Fact' }, 100000);
      g.addRelation('D1', { type: 'Scan', table: 'D1' }, 100);
      g.addRelation('D2', { type: 'Scan', table: 'D2' }, 50);
      g.addRelation('D3', { type: 'Scan', table: 'D3' }, 200);

      g.addEdge(['Fact'], ['D1'], makeEqPred('Fact', 'd1_id', 'D1', 'id'));
      g.addEdge(['Fact'], ['D2'], makeEqPred('Fact', 'd2_id', 'D2', 'id'));
      g.addEdge(['Fact'], ['D3'], makeEqPred('Fact', 'd3_id', 'D3', 'id'));

      const result = new DPhypEnumerator(g, new DefaultCostModel(), simpleEstimator()).solve();

      expect(result).not.toBeNull();
      expect(result.mask).toBe(0b1111);
    });
  });

  describe('disconnected graph', () => {
    it('returns null when no valid join order exists', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
      g.addRelation('B', { type: 'Scan', table: 'B' }, 200);

      const result = new DPhypEnumerator(g, new DefaultCostModel(), simpleEstimator()).solve();
      expect(result).toBeNull();
    });
  });

  describe('single relation', () => {
    it('returns the base relation plan', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 100);

      const result = new DPhypEnumerator(g, new DefaultCostModel(), simpleEstimator()).solve();
      expect(result).not.toBeNull();
      expect(result.plan.type).toBe('Scan');
      expect(result.cardinality).toBe(100);
    });
  });

  describe('cost optimality', () => {
    it('prefers the cheaper join order among alternatives', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 10);
      g.addRelation('B', { type: 'Scan', table: 'B' }, 10000);
      g.addRelation('C', { type: 'Scan', table: 'C' }, 10);
      g.addEdge(['A'], ['B'], makeEqPred('A', 'id', 'B', 'a_id'));
      g.addEdge(['B'], ['C'], makeEqPred('B', 'id', 'C', 'b_id'));
      g.addEdge(['A'], ['C'], makeEqPred('A', 'id', 'C', 'a_id'));

      const cost = new DefaultCostModel();
      const result = new DPhypEnumerator(g, cost, simpleEstimator()).solve();

      const g2 = new HyperGraph();
      g2.addRelation('A', { type: 'Scan', table: 'A' }, 10);
      g2.addRelation('B', { type: 'Scan', table: 'B' }, 10000);
      g2.addRelation('C', { type: 'Scan', table: 'C' }, 10);
      g2.addEdge(['A'], ['B'], makeEqPred('A', 'id', 'B', 'a_id'));
      g2.addEdge(['B'], ['C'], makeEqPred('B', 'id', 'C', 'b_id'));
      g2.addEdge(['A'], ['C'], makeEqPred('A', 'id', 'C', 'a_id'));

      const naiveResult = new DPhypEnumerator(g2, cost, {
        estimateJoin: (l, r) => l * r,
      }).solve();

      expect(result.totalCost).toBeLessThanOrEqual(naiveResult.totalCost);
    });
  });

  describe('predicate deduplication', () => {
    it('does not duplicate predicates in combined condition', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
      g.addRelation('B', { type: 'Scan', table: 'B' }, 100);
      const pred = makeEqPred('A', 'id', 'B', 'a_id');
      g.addEdge(['A'], ['B'], pred);
      g.addEdge(['A'], ['B'], pred);

      const result = new DPhypEnumerator(g, new DefaultCostModel(), simpleEstimator()).solve();
      expect(result).not.toBeNull();
      expect(result.plan.condition).toBe(pred);
    });
  });

  describe('relation count overflow guard', () => {
    it('gracefully handles >30 relations by stopping enumeration', () => {
      const g = new HyperGraph();
      for (let i = 0; i < 35; i++) {
        const id = g.addRelation(`R${i}`, { type: 'Scan', table: `R${i}` }, 100);
        if (i >= 30) {
          expect(id).toBe(-1);
        }
      }
      expect(g.size).toBe(30);
    });
  });

  describe('hypergraph findJoinPredicates dedup', () => {
    it('returns each predicate at most once for symmetric edges', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
      g.addRelation('B', { type: 'Scan', table: 'B' }, 100);
      const pred = makeEqPred('A', 'id', 'B', 'a_id');
      g.addEdge(['A'], ['B'], pred);

      const leftMask = 1;
      const rightMask = 2;
      const preds = g.findJoinPredicates(leftMask, rightMask);
      expect(preds).toHaveLength(1);

      const predsReversed = g.findJoinPredicates(rightMask, leftMask);
      expect(predsReversed).toHaveLength(1);
    });
  });
});

describe('DPhypEnumerator optimality', () => {
  const shapes = {
    chain: chainEdges,
    star: starEdges,
    cycle: cycleEdges,
    clique: cliqueEdges,
  };

  for (const [shapeName, makeEdges] of Object.entries(shapes)) {
    for (const size of [3, 4, 5, 6, 7]) {
      it(`matches brute-force optimum on a ${size}-relation ${shapeName}`, () => {
        const random = seededRandom(size * 31 + shapeName.length);
        const cardinalities = Array.from({ length: size }, () => 10 + Math.floor(random() * 100000));
        const costModel = new DefaultCostModel();
        const estimator = proportionalEstimator();

        const reference = bruteForceOptimum(buildGraph(cardinalities, makeEdges(size)), costModel, estimator);
        const actual = new DPhypEnumerator(buildGraph(cardinalities, makeEdges(size)), costModel, estimator).solve();

        expect(reference).not.toBeNull();
        expect(actual).not.toBeNull();
        expect(actual.mask).toBe(reference.mask);
        expect(actual.totalCost).toBeCloseTo(reference.totalCost, 6);
      });
    }
  }

  it('matches brute-force optimum across randomly generated graphs', () => {
    const costModel = new DefaultCostModel();
    const estimator = proportionalEstimator();

    for (let seed = 1; seed <= 40; seed++) {
      const random = seededRandom(seed);
      const size = 3 + (seed % 5);
      const edges = randomConnectedEdges(size, random);
      const cardinalities = Array.from({ length: size }, () => 5 + Math.floor(random() * 50000));

      const reference = bruteForceOptimum(buildGraph(cardinalities, edges), costModel, estimator);
      const actual = new DPhypEnumerator(buildGraph(cardinalities, edges), costModel, estimator).solve();

      expect(actual, `seed ${seed}`).not.toBeNull();
      expect(actual.totalCost, `seed ${seed}`).toBeCloseTo(reference.totalCost, 6);
    }
  });

  it('covers every relation of a wide star that a size-ordered scan would miss', () => {
    const size = 9;
    const cardinalities = [1000000, ...Array.from({ length: size - 1 }, (_, i) => (i + 1) * 50)];
    const graph = buildGraph(cardinalities, starEdges(size));

    const result = new DPhypEnumerator(graph, new DefaultCostModel(), proportionalEstimator()).solve();

    expect(result).not.toBeNull();
    expect(result.mask).toBe(graph.fullMask);
  });
});

describe('DPhypEnumerator enumeration budget', () => {
  it('reports exhaustion and returns null once the pair budget is spent', () => {
    const graph = buildGraph(Array.from({ length: 8 }, () => 1000), cliqueEdges(8));
    const enumerator = new DPhypEnumerator(graph, new DefaultCostModel(), proportionalEstimator(), 5);

    const result = enumerator.solve();

    expect(result).toBeNull();
    expect(enumerator.budgetExhausted).toBe(true);
    expect(enumerator.pairsEmitted).toBeGreaterThan(5);
  });

  it('completes within budget for a chain and leaves the flag clear', () => {
    const graph = buildGraph(Array.from({ length: 8 }, () => 1000), chainEdges(8));
    const enumerator = new DPhypEnumerator(graph, new DefaultCostModel(), proportionalEstimator());

    const result = enumerator.solve();

    expect(result).not.toBeNull();
    expect(enumerator.budgetExhausted).toBe(false);
  });

  it('emits far fewer pairs on a chain than on a clique of the same size', () => {
    const size = 9;
    const chain = new DPhypEnumerator(buildGraph(Array.from({ length: size }, () => 1000), chainEdges(size)), new DefaultCostModel(), proportionalEstimator());
    const clique = new DPhypEnumerator(buildGraph(Array.from({ length: size }, () => 1000), cliqueEdges(size)), new DefaultCostModel(), proportionalEstimator());

    chain.solve();
    clique.solve();

    expect(chain.pairsEmitted).toBeLessThan(clique.pairsEmitted);
  });

  it('never enumerates a pair whose sides lack a connecting predicate', () => {
    const graph = buildGraph([100, 200, 300, 400], chainEdges(4));
    const enumerator = new DPhypEnumerator(graph, new DefaultCostModel(), proportionalEstimator());
    const seen = [];
    const original = enumerator.emitCsgCmp.bind(enumerator);
    enumerator.emitCsgCmp = (left, right) => {
      seen.push([left, right]);
      return original(left, right);
    };

    enumerator.solve();

    expect(seen.length).toBeGreaterThan(0);
    for (const [left, right] of seen) {
      expect(graph.isConnected(left)).toBe(true);
      expect(graph.isConnected(right)).toBe(true);
      expect(graph.hasJoinPredicate(left, right)).toBe(true);
    }
  });
});
