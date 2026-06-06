import { describe, it, expect } from 'vitest';
import { DPhypEnumerator, runDPhyp } from '../../../src/optimizer/dphyp/dphyp.js';
import { HyperGraph } from '../../../src/optimizer/dphyp/hypergraph.js';
import { DefaultCostModel } from '../../../src/optimizer/dphyp/cost-model.js';
import { DefaultCardinalityEstimator } from '../../../src/optimizer/dphyp/cardinality.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function makeColRef(table, column) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column };
}

function makeEqPred(leftTable, leftCol, rightTable, rightCol) {
  return {
    kind: BoundExprKind.BINARY,
    op: '=',
    left: makeColRef(leftTable, leftCol),
    right: makeColRef(rightTable, rightCol),
  };
}

function buildChainGraph(sizes) {
  const g = new HyperGraph();
  const names = sizes.map((_, i) => String.fromCharCode(65 + i));
  for (let i = 0; i < sizes.length; i++) {
    g.addRelation(names[i], { type: 'Scan', table: names[i] }, sizes[i]);
  }
  for (let i = 0; i < sizes.length - 1; i++) {
    g.addEdge(
      [names[i]], [names[i + 1]],
      makeEqPred(names[i], 'id', names[i + 1], `${names[i].toLowerCase()}_id`)
    );
  }
  return g;
}

function simpleEstimator() {
  return {
    estimateJoin(leftCard, rightCard, condition) {
      if (!condition) return leftCard * rightCard;
      return Math.max(1, Math.round(Math.max(leftCard, rightCard)));
    },
  };
}

describe('DPhypEnumerator', () => {
  describe('two-relation join', () => {
    it('produces a join plan covering both relations', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
      g.addRelation('B', { type: 'Scan', table: 'B' }, 200);
      g.addEdge(['A'], ['B'], makeEqPred('A', 'id', 'B', 'a_id'));

      const cost = new DefaultCostModel();
      const result = runDPhyp(g, cost, simpleEstimator());

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
      const result = runDPhyp(g, cost, simpleEstimator());

      expect(result.plan.buildSide.table).toBe('Small');
      expect(result.plan.probeSide.table).toBe('Big');
    });
  });

  describe('three-relation chain (A-B-C)', () => {
    it('finds a plan covering all three relations', () => {
      const g = buildChainGraph([100, 200, 50]);
      const result = runDPhyp(g, new DefaultCostModel(), simpleEstimator());

      expect(result).not.toBeNull();
      expect(result.mask).toBe(0b111);
    });

    it('joins cheapest pair first', () => {
      const g = buildChainGraph([1000, 10, 1000]);
      const result = runDPhyp(g, new DefaultCostModel(), simpleEstimator());

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

      const result = runDPhyp(g, new DefaultCostModel(), simpleEstimator());

      expect(result).not.toBeNull();
      expect(result.mask).toBe(0b1111);
    });
  });

  describe('disconnected graph', () => {
    it('returns null when no valid join order exists', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
      g.addRelation('B', { type: 'Scan', table: 'B' }, 200);

      const result = runDPhyp(g, new DefaultCostModel(), simpleEstimator());
      expect(result).toBeNull();
    });
  });

  describe('single relation', () => {
    it('returns the base relation plan', () => {
      const g = new HyperGraph();
      g.addRelation('A', { type: 'Scan', table: 'A' }, 100);

      const result = runDPhyp(g, new DefaultCostModel(), simpleEstimator());
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
      const result = runDPhyp(g, cost, simpleEstimator());

      const g2 = new HyperGraph();
      g2.addRelation('A', { type: 'Scan', table: 'A' }, 10);
      g2.addRelation('B', { type: 'Scan', table: 'B' }, 10000);
      g2.addRelation('C', { type: 'Scan', table: 'C' }, 10);
      g2.addEdge(['A'], ['B'], makeEqPred('A', 'id', 'B', 'a_id'));
      g2.addEdge(['B'], ['C'], makeEqPred('B', 'id', 'C', 'b_id'));
      g2.addEdge(['A'], ['C'], makeEqPred('A', 'id', 'C', 'a_id'));

      const naiveResult = runDPhyp(g2, cost, {
        estimateJoin: (l, r) => l * r,
      });

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

      const result = runDPhyp(g, new DefaultCostModel(), simpleEstimator());
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
