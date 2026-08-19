import { describe, it, expect } from 'vitest';
import {
  HyperGraph,
  HyperEdge,
  popcount,
  subsets,
  subsetsByAscendingSize,
  bitIndices,
  descendingBitIndices,
  lowestBitIndex,
  maskBelowOrEqual,
  buildHyperGraph,
  BITMASK_RELATION_CAPACITY,
} from '../../../src/optimizer/join-order/hypergraph.js';
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

    it('keeps a relation addressable when a later one asks for the same name', () => {
      const g = new HyperGraph();
      const first = g.addRelation('T', null, 10);
      const second = g.addRelation('T', null, 20);

      const keys = [...g.relationIndex.keys()];
      expect(keys).toHaveLength(2);
      expect(keys.map(key => g.relationIndex.get(key))).toEqual([first, second]);
    });

    it('leaves the first claimant of a name owning it, so edges land on one relation', () => {
      const g = new HyperGraph();
      const first = g.addRelation('T', null, 10);
      g.addRelation('T', null, 20);

      expect(g.maskOfNames(['T'])).toBe(1 << first);
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

  describe('neighborhood', () => {
    it('returns adjacent relations excluding the subset itself', () => {
      const g = buildTriangle();
      const neighborsOfA = g.neighborhood(0b001, 0);
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
      const neighbors = g.neighborhood(0b0011, 0);
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

  it('reports a predicate it cannot turn into an edge instead of dropping it', () => {
    const relations = [
      { name: 'A', plan: {} },
      { name: 'B', plan: {} },
    ];
    const danglingRef = {
      kind: BoundExprKind.BINARY,
      op: '=',
      left: makeColRef('A', 'x'),
      right: makeColRef('MISSING', 'y'),
    };
    const estimator = { estimateScan: () => 100 };
    const graph = buildHyperGraph(relations, [danglingRef], estimator);

    expect(graph.edges).toHaveLength(0);
    expect(graph.unrepresentedPredicates).toContain(danglingRef);
  });

  it('falls back to a two-sided edge when the operand sides overlap', () => {
    const relations = [
      { name: 'A', plan: {} },
      { name: 'B', plan: {} },
    ];
    // (A.x + B.x) = B.y — left refs {A,B} overlap right refs {B}.
    const overlapping = {
      kind: BoundExprKind.BINARY,
      op: '=',
      left: {
        kind: BoundExprKind.BINARY,
        op: '+',
        left: makeColRef('A', 'x'),
        right: makeColRef('B', 'x'),
      },
      right: makeColRef('B', 'y'),
    };
    const estimator = { estimateScan: () => 100 };
    const graph = buildHyperGraph(relations, [overlapping], estimator);

    expect(graph.unrepresentedPredicates).toHaveLength(0);
    expect(graph.edges).toHaveLength(1);
    expect(graph.findJoinPredicates(1 << graph.relationIndex.get('A'), 1 << graph.relationIndex.get('B')))
      .toContain(overlapping);
  });

  it('builds a single hyperedge from a multi-table equality (no all-pairs clique)', () => {
    const relations = [
      { name: 'A', plan: {} },
      { name: 'B', plan: {} },
      { name: 'C', plan: {} },
    ];
    // (A.x + B.x) = C.y  →  one edge connecting {A,B} to {C}, NOT a 3-clique.
    const pred = {
      kind: BoundExprKind.BINARY,
      op: '=',
      left: {
        kind: BoundExprKind.BINARY,
        op: '+',
        left: makeColRef('A', 'x'),
        right: makeColRef('B', 'x'),
      },
      right: makeColRef('C', 'y'),
    };
    const estimator = { estimateScan: () => 100 };
    const graph = buildHyperGraph(relations, [pred], estimator);

    const a = 1 << graph.relationIndex.get('A');
    const b = 1 << graph.relationIndex.get('B');
    const c = 1 << graph.relationIndex.get('C');

    expect(graph.edges).toHaveLength(1);
    const edge = graph.edges[0];
    expect(edge.leftMask | edge.rightMask).toBe(a | b | c);
    // one side is exactly {A,B}, the other exactly {C}
    expect([edge.leftMask, edge.rightMask]).toContain(a | b);
    expect([edge.leftMask, edge.rightMask]).toContain(c);
  });
});

describe('subsetsByAscendingSize', () => {
  it('returns nothing for an empty mask', () => {
    expect(subsetsByAscendingSize(0)).toEqual([]);
  });

  it('returns the same members as the unordered enumeration', () => {
    const ordered = subsetsByAscendingSize(0b1011);
    expect([...ordered].sort((a, b) => a - b)).toEqual([...subsets(0b1011)].sort((a, b) => a - b));
  });

  it('emits singletons before larger subsets', () => {
    const ordered = subsetsByAscendingSize(0b111);
    expect(ordered.slice(0, 3).every(mask => popcount(mask) === 1)).toBe(true);
  });

  it('emits the full mask last', () => {
    const ordered = subsetsByAscendingSize(0b1111);
    expect(ordered[ordered.length - 1]).toBe(0b1111);
  });

  it('never decreases in subset size', () => {
    const sizes = subsetsByAscendingSize(0b11111).map(popcount);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    }
  });

  it('differs from the unordered enumeration order for multi-bit masks', () => {
    expect(subsetsByAscendingSize(0b111)).not.toEqual(subsets(0b111));
  });
});

describe('bit helpers', () => {
  it('lists no indices for an empty mask', () => {
    expect([...bitIndices(0)]).toEqual([]);
  });

  it('lists set-bit indices in ascending order', () => {
    expect([...bitIndices(0b1010)]).toEqual([1, 3]);
  });

  it('lists set-bit indices in descending order', () => {
    expect(descendingBitIndices(0b1010)).toEqual([3, 1]);
  });

  it('finds the lowest set bit index', () => {
    expect(lowestBitIndex(0b1100)).toBe(2);
  });

  it('builds a mask covering every index up to and including the given one', () => {
    expect(maskBelowOrEqual(3)).toBe(0b1111);
  });

  it('builds a single-bit mask for index zero', () => {
    expect(maskBelowOrEqual(0)).toBe(0b1);
  });
});

describe('HyperGraph relation capacity', () => {
  it('rejects relations past the bitmask capacity', () => {
    const graph = new HyperGraph();
    for (let i = 0; i < BITMASK_RELATION_CAPACITY; i++) {
      expect(graph.addRelation(`R${i}`, { type: 'Scan' }, 1)).toBe(i);
    }

    expect(graph.addRelation('OVERFLOW', { type: 'Scan' }, 1)).toBe(-1);
  });

  it('keeps fullMask positive at capacity', () => {
    const graph = new HyperGraph();
    for (let i = 0; i < BITMASK_RELATION_CAPACITY; i++) graph.addRelation(`R${i}`, { type: 'Scan' }, 1);

    expect(graph.fullMask).toBeGreaterThan(0);
  });
});

describe('HyperGraph neighborhood exclusion', () => {
  function triangle() {
    const graph = new HyperGraph();
    graph.addRelation('A', { type: 'Scan' }, 1);
    graph.addRelation('B', { type: 'Scan' }, 1);
    graph.addRelation('C', { type: 'Scan' }, 1);
    graph.addEdge(['A'], ['B'], {});
    graph.addEdge(['B'], ['C'], {});
    graph.addEdge(['A'], ['C'], {});
    return graph;
  }

  it('removes excluded relations from the neighborhood', () => {
    expect(triangle().neighborhood(0b001, 0b010)).toBe(0b100);
  });

  it('returns nothing when everything adjacent is excluded', () => {
    expect(triangle().neighborhood(0b001, 0b110)).toBe(0);
  });

  it('never includes the subset itself', () => {
    expect(triangle().neighborhood(0b011, 0) & 0b011).toBe(0);
  });

  it('returns nothing for an isolated relation', () => {
    const graph = new HyperGraph();
    graph.addRelation('A', { type: 'Scan' }, 1);
    graph.addRelation('B', { type: 'Scan' }, 1);

    expect(graph.neighborhood(0b01, 0)).toBe(0);
  });

  it('serves a repeated query from the memoised adjacency union', () => {
    const graph = triangle();
    const first = graph.neighborhood(0b011, 0);
    const cachedSize = graph.adjacencyUnionCache.size;
    const second = graph.neighborhood(0b011, 0);

    expect(second).toBe(first);
    expect(graph.adjacencyUnionCache.size).toBe(cachedSize);
  });

  it('invalidates the memo when a new edge arrives', () => {
    const graph = triangle();
    graph.neighborhood(0b001, 0);
    graph.addRelation('D', { type: 'Scan' }, 1);
    graph.addEdge(['A'], ['D'], {});

    expect(graph.neighborhood(0b0001, 0) & 0b1000).toBeTruthy();
  });
});

describe('HyperGraph hasJoinPredicate', () => {
  function chain() {
    const graph = new HyperGraph();
    graph.addRelation('A', { type: 'Scan' }, 1);
    graph.addRelation('B', { type: 'Scan' }, 1);
    graph.addRelation('C', { type: 'Scan' }, 1);
    graph.addEdge(['A'], ['B'], { id: 'ab' });
    graph.addEdge(['B'], ['C'], { id: 'bc' });
    return graph;
  }

  it('reports a predicate between directly connected relations', () => {
    expect(chain().hasJoinPredicate(0b001, 0b010)).toBe(true);
  });

  it('reports no predicate between unconnected relations', () => {
    expect(chain().hasJoinPredicate(0b001, 0b100)).toBe(false);
  });

  it('reports a predicate when one side is a grouped subplan', () => {
    expect(chain().hasJoinPredicate(0b011, 0b100)).toBe(true);
  });

  it('agrees with findJoinPredicates on every pair it is asked about', () => {
    const graph = chain();
    for (let left = 1; left <= graph.fullMask; left++) {
      const right = graph.fullMask & ~left;
      if (right === 0) continue;
      expect(graph.hasJoinPredicate(left, right)).toBe(graph.findJoinPredicates(left, right).length > 0);
    }
  });
});

describe('HyperEdge spans', () => {
  it('accepts a pair that straddles the edge', () => {
    expect(new HyperEdge(0b01, 0b10, {}).spans(0b01, 0b10)).toBe(true);
  });

  it('accepts the reversed orientation', () => {
    expect(new HyperEdge(0b01, 0b10, {}).spans(0b10, 0b01)).toBe(true);
  });

  it('rejects a pair that leaves part of the edge outside', () => {
    expect(new HyperEdge(0b011, 0b100, {}).spans(0b001, 0b100)).toBe(false);
  });

  it('rejects a pair that keeps the whole edge on one side', () => {
    expect(new HyperEdge(0b01, 0b10, {}).spans(0b11, 0b100)).toBe(false);
  });
});
