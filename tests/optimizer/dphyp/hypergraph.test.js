import { describe, it, expect } from 'vitest';
import { HyperGraph, HyperEdge, popcount, subsets, buildHyperGraph } from '../../../src/optimizer/dphyp/hypergraph.js';
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

describe('popcount', () => {
  it('counts bits in zero', () => {
    expect(popcount(0)).toBe(0);
  });

  it('counts bits in powers of two', () => {
    expect(popcount(1)).toBe(1);
    expect(popcount(2)).toBe(1);
    expect(popcount(4)).toBe(1);
    expect(popcount(8)).toBe(1);
  });

  it('counts bits in mixed values', () => {
    expect(popcount(0b111)).toBe(3);
    expect(popcount(0b1010)).toBe(2);
    expect(popcount(0b11111)).toBe(5);
    expect(popcount(0b10101010)).toBe(4);
  });
});

describe('subsets', () => {
  it('returns empty array for mask 0', () => {
    expect(subsets(0)).toEqual([]);
  });

  it('returns single element for single-bit mask', () => {
    expect(subsets(0b1)).toEqual([1]);
    expect(subsets(0b100)).toEqual([4]);
  });

  it('enumerates all non-empty subsets of 0b111', () => {
    const result = subsets(0b111);
    expect(result).toHaveLength(7);
    expect(new Set(result)).toEqual(new Set([0b001, 0b010, 0b011, 0b100, 0b101, 0b110, 0b111]));
  });

  it('only generates subsets within the mask', () => {
    const mask = 0b1010;
    const result = subsets(mask);
    for (const s of result) {
      expect(s & mask).toBe(s);
      expect(s).toBeGreaterThan(0);
    }
    expect(result).toHaveLength(3);
  });
});

describe('HyperEdge', () => {
  it('stores left mask, right mask, and predicate', () => {
    const pred = makeEqPred('A', 'id', 'B', 'a_id');
    const edge = new HyperEdge(0b01, 0b10, pred);
    expect(edge.leftMask).toBe(1);
    expect(edge.rightMask).toBe(2);
    expect(edge.predicate).toBe(pred);
  });
});

describe('HyperGraph', () => {
  function buildTriangle() {
    const g = new HyperGraph();
    g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
    g.addRelation('B', { type: 'Scan', table: 'B' }, 200);
    g.addRelation('C', { type: 'Scan', table: 'C' }, 50);
    const predAB = makeEqPred('A', 'id', 'B', 'a_id');
    const predBC = makeEqPred('B', 'id', 'C', 'b_id');
    const predAC = makeEqPred('A', 'id', 'C', 'a_id');
    g.addEdge(['A'], ['B'], predAB);
    g.addEdge(['B'], ['C'], predBC);
    g.addEdge(['A'], ['C'], predAC);
    return g;
  }

  describe('addRelation', () => {
    it('assigns sequential ids and bitmasks', () => {
      const g = new HyperGraph();
      const id0 = g.addRelation('X', null, 10);
      const id1 = g.addRelation('Y', null, 20);
      expect(id0).toBe(0);
      expect(id1).toBe(1);
      expect(g.relations[0].mask).toBe(0b01);
      expect(g.relations[1].mask).toBe(0b10);
    });

    it('indexes relations case-insensitively', () => {
      const g = new HyperGraph();
      g.addRelation('orders', null, 100);
      expect(g.relationIndex.get('ORDERS')).toBe(0);
    });
  });

  describe('addEdge', () => {
    it('creates edge with correct masks', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addEdge(['A'], ['B'], { pred: true });
      expect(g.edges).toHaveLength(1);
      expect(g.edges[0].leftMask).toBe(0b01);
      expect(g.edges[0].rightMask).toBe(0b10);
    });

    it('updates adjacency lists bidirectionally', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addEdge(['A'], ['B'], {});
      expect(g.adjacency[0] & 0b10).toBeTruthy();
      expect(g.adjacency[1] & 0b01).toBeTruthy();
    });

    it('skips edge if relation name is unknown', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addEdge(['A'], ['UNKNOWN'], {});
      expect(g.edges).toHaveLength(0);
    });
  });

  describe('getNeighborhood', () => {
    it('returns adjacent relations excluding the subset itself', () => {
      const g = buildTriangle();
      const neighborsOfA = g.getNeighborhood(0b001);
      expect(neighborsOfA & 0b010).toBeTruthy();
      expect(neighborsOfA & 0b100).toBeTruthy();
      expect(neighborsOfA & 0b001).toBeFalsy();
    });

    it('returns union of neighbors for multi-relation subset', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addRelation('C', null, 30);
      g.addRelation('D', null, 40);
      g.addEdge(['A'], ['B'], {});
      g.addEdge(['B'], ['C'], {});
      g.addEdge(['C'], ['D'], {});
      const neighbors = g.getNeighborhood(0b0011);
      expect(neighbors & 0b0100).toBeTruthy();
      expect(neighbors & 0b0001).toBeFalsy();
      expect(neighbors & 0b0010).toBeFalsy();
    });
  });

  describe('isConnected', () => {
    it('returns false for empty subset', () => {
      const g = buildTriangle();
      expect(g.isConnected(0)).toBe(false);
    });

    it('returns true for a single relation', () => {
      const g = buildTriangle();
      expect(g.isConnected(0b001)).toBe(true);
    });

    it('returns true for directly connected pair', () => {
      const g = buildTriangle();
      expect(g.isConnected(0b011)).toBe(true);
    });

    it('returns true for full triangle', () => {
      const g = buildTriangle();
      expect(g.isConnected(0b111)).toBe(true);
    });

    it('returns false for disconnected pair', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addRelation('C', null, 30);
      g.addEdge(['A'], ['B'], {});
      expect(g.isConnected(0b101)).toBe(false);
    });
  });

  describe('findJoinPredicates', () => {
    it('finds predicate between two relations', () => {
      const pred = makeEqPred('A', 'id', 'B', 'a_id');
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addEdge(['A'], ['B'], pred);
      const found = g.findJoinPredicates(0b01, 0b10);
      expect(found).toContain(pred);
    });

    it('finds predicate regardless of argument order', () => {
      const pred = makeEqPred('A', 'id', 'B', 'a_id');
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addEdge(['A'], ['B'], pred);
      const found = g.findJoinPredicates(0b10, 0b01);
      expect(found).toContain(pred);
    });

    it('returns empty when no matching predicates', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addRelation('C', null, 30);
      g.addEdge(['A'], ['B'], {});
      expect(g.findJoinPredicates(0b001, 0b100)).toEqual([]);
    });
  });

  describe('size and fullMask', () => {
    it('returns correct size', () => {
      const g = buildTriangle();
      expect(g.size).toBe(3);
    });

    it('returns correct fullMask', () => {
      const g = buildTriangle();
      expect(g.fullMask).toBe(0b111);
    });
  });
});

describe('buildHyperGraph', () => {
  it('builds graph from relations and join predicates', () => {
    const relations = [
      { name: 'orders', alias: 'O', plan: { type: 'Scan', table: 'orders' } },
      { name: 'customers', alias: 'C', plan: { type: 'Scan', table: 'customers' } },
    ];
    const pred = makeEqPred('O', 'customer_id', 'C', 'id');
    const estimator = { estimateScan: () => 500 };
    const graph = buildHyperGraph(relations, [pred], estimator);

    expect(graph.size).toBe(2);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.relationIndex.has('O')).toBe(true);
    expect(graph.relationIndex.has('C')).toBe(true);
  });

  it('uses estimatePlan when available', () => {
    const relations = [
      { name: 'T', plan: { type: 'Scan', table: 'T' } },
    ];
    const estimator = { estimatePlan: (plan) => plan.table === 'T' ? 999 : 0 };
    const graph = buildHyperGraph(relations, [], estimator);
    expect(graph.relations[0].cardinality).toBe(999);
  });

  it('skips predicates referencing fewer than 2 tables', () => {
    const relations = [
      { name: 'A', plan: {} },
      { name: 'B', plan: {} },
    ];
    const singleTablePred = {
      kind: BoundExprKind.BINARY,
      op: '>',
      left: makeColRef('A', 'x'),
      right: { kind: BoundExprKind.LITERAL, value: 10 },
    };
    const estimator = { estimateScan: () => 100 };
    const graph = buildHyperGraph(relations, [singleTablePred], estimator);
    expect(graph.edges).toHaveLength(0);
  });

  it('handles three-way join predicates by creating pairwise edges', () => {
    const relations = [
      { name: 'A', plan: {} },
      { name: 'B', plan: {} },
      { name: 'C', plan: {} },
    ];
    const threeWayPred = {
      kind: BoundExprKind.BINARY,
      op: 'AND',
      left: makeEqPred('A', 'id', 'B', 'a_id'),
      right: makeColRef('C', 'x'),
    };
    const estimator = { estimateScan: () => 100 };
    const graph = buildHyperGraph(relations, [threeWayPred], estimator);
    expect(graph.edges.length).toBeGreaterThanOrEqual(3);
  });
});
