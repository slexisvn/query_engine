import { describe, it, expect } from 'vitest';
import { HyperGraph, HyperEdge, buildJoinHyperGraph } from '../../../src/optimizer/join-order/hypergraph.js';
import { BITMASK_RELATION_CAPACITY } from '../../../src/optimizer/join-order/bitmask.js';
import { computeJoinConstraints } from '../../../src/optimizer/join-order/join-conflicts.js';
import { JoinType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { addJoinEdge, makeColRef, makeEqPred, operatorNode, predicateEntry, relationLeaf, scanRelations } from '../../helpers/join-graphs.js';

function innerEdge(leftMask, rightMask, predicate = {}) {
  return new HyperEdge({
    joinType: JoinType.INNER,
    source: null,
    predicate,
    leftMask,
    rightMask,
    requiredLeft: 0,
    requiredRight: 0,
    tesMask: leftMask | rightMask,
  });
}

describe('HyperEdge', () => {
  it('stores left mask, right mask, and predicate', () => {
    const pred = makeEqPred('A', 'id', 'B', 'a_id');
    const edge = innerEdge(0b01, 0b10, pred);
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

  describe('resolveJoin', () => {
    it('finds predicate between two relations', () => {
      const pred = makeEqPred('A', 'id', 'B', 'a_id');
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addEdge(['A'], ['B'], pred);
      expect(g.resolveJoin(0b01, 0b10).predicates).toContain(pred);
    });

    it('finds predicate regardless of argument order', () => {
      const pred = makeEqPred('A', 'id', 'B', 'a_id');
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addEdge(['A'], ['B'], pred);
      expect(g.resolveJoin(0b10, 0b01).predicates).toContain(pred);
    });

    it('returns null when no edge connects the two sides', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addRelation('C', null, 30);
      g.addEdge(['A'], ['B'], {});
      expect(g.resolveJoin(0b001, 0b100)).toBeNull();
    });

    it('applies a lone non-inner operator and reports its orientation', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      const pred = makeEqPred('A', 'id', 'B', 'a_id');
      addJoinEdge(g, JoinType.LEFT, ['A'], ['B'], pred);

      const forward = g.resolveJoin(0b01, 0b10);
      expect(forward.joinType).toBe(JoinType.LEFT);
      expect(forward.swapped).toBe(false);
      expect(forward.predicates).toEqual([pred]);
    });

    it('reports a swapped orientation when the operator operands arrive reversed', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      addJoinEdge(g, JoinType.LEFT, ['A'], ['B'], makeEqPred('A', 'id', 'B', 'a_id'));

      expect(g.resolveJoin(0b10, 0b01).swapped).toBe(true);
    });

    it('refuses a split where a non-inner operator would share the node with an inner predicate', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      addJoinEdge(g, JoinType.LEFT, ['A'], ['B'], makeEqPred('A', 'id', 'B', 'a_id'));
      g.addEdge(['A'], ['B'], makeEqPred('A', 'code', 'B', 'code'));

      expect(g.resolveJoin(0b01, 0b10)).toBeNull();
    });

    it('refuses a split where two non-inner operators become applicable together', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      addJoinEdge(g, JoinType.LEFT, ['A'], ['B'], makeEqPred('A', 'id', 'B', 'a_id'));
      addJoinEdge(g, JoinType.SEMI, ['A'], ['B'], makeEqPred('A', 'code', 'B', 'code'));

      expect(g.resolveJoin(0b01, 0b10)).toBeNull();
    });

    it('refuses a split that tears a required operand of a non-inner operator in two', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      g.addRelation('C', null, 30);
      addJoinEdge(g, JoinType.LEFT, ['A', 'B'], ['C'], makeEqPred('B', 'id', 'C', 'b_id'));

      expect(g.resolveJoin(0b011, 0b100)).not.toBeNull();
      expect(g.resolveJoin(0b100, 0b011).swapped).toBe(true);
      expect(g.resolveJoin(0b101, 0b010)).toBeNull();
      expect(g.resolveJoin(0b010, 0b101)).toBeNull();
    });

    it('conjoins every inner predicate that spans the split', () => {
      const g = new HyperGraph();
      g.addRelation('A', null, 10);
      g.addRelation('B', null, 20);
      const first = makeEqPred('A', 'id', 'B', 'a_id');
      const second = makeEqPred('A', 'code', 'B', 'code');
      g.addEdge(['A'], ['B'], first);
      g.addEdge(['A'], ['B'], second);

      expect(g.resolveJoin(0b01, 0b10).predicates).toEqual([first, second]);
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

describe('buildJoinHyperGraph', () => {
  function twoRelationBlock(joinType, predicate, sesMask) {
    const tree = operatorNode(
      joinType,
      relationLeaf(0),
      relationLeaf(1),
      [predicateEntry(predicate, sesMask, (sesMask & 0b01) || 0b01, (sesMask & 0b10) || 0b10)],
    );
    return { tree, constraints: computeJoinConstraints(tree) };
  }

  it('uses estimatePlan when available', () => {
    const estimator = { estimatePlan: plan => (plan.table === 'T' ? 999 : 0) };
    const graph = buildJoinHyperGraph(scanRelations(['T']), [], estimator);
    expect(graph.relations[0].cardinality).toBe(999);
  });

  it('falls back to estimateScan when estimatePlan is absent', () => {
    const graph = buildJoinHyperGraph(scanRelations(['T']), [], { estimateScan: () => 500 });
    expect(graph.relations[0].cardinality).toBe(500);
  });

  it('creates one inner edge per predicate entry', () => {
    const pred = makeEqPred('A', 'id', 'B', 'a_id');
    const { constraints } = twoRelationBlock(JoinType.INNER, pred, 0b11);
    const graph = buildJoinHyperGraph(scanRelations(['A', 'B']), constraints, { estimateScan: () => 10 });

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].predicate).toBe(pred);
    expect(graph.edges[0].joinType).toBe(JoinType.INNER);
    expect(graph.edges[0].requiredLeft).toBe(0);
  });

  it('keeps a multi-relation predicate as one hyperedge rather than a clique', () => {
    const pred = {
      kind: BoundExprKind.BINARY,
      op: '=',
      left: { kind: BoundExprKind.BINARY, op: '+', left: makeColRef('A', 'x'), right: makeColRef('B', 'x') },
      right: makeColRef('C', 'y'),
    };
    const inner = operatorNode(JoinType.INNER, relationLeaf(0), relationLeaf(1), []);
    const tree = operatorNode(JoinType.INNER, inner, relationLeaf(2), [predicateEntry(pred, 0b111, 0b011, 0b100)]);
    const graph = buildJoinHyperGraph(scanRelations(['A', 'B', 'C']), computeJoinConstraints(tree), { estimateScan: () => 10 });

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].leftMask).toBe(0b011);
    expect(graph.edges[0].rightMask).toBe(0b100);
    expect(graph.adjacency[0] & 0b010).toBe(0);
  });

  it('marks an outer join edge as non-conjunctive and pins it to its operands', () => {
    const pred = makeEqPred('A', 'id', 'B', 'a_id');
    const { constraints } = twoRelationBlock(JoinType.LEFT, pred, 0b11);
    const graph = buildJoinHyperGraph(scanRelations(['A', 'B']), constraints, { estimateScan: () => 10 });

    expect(graph.edges[0].joinType).toBe(JoinType.LEFT);
    expect(graph.edges[0].conjunctive).toBe(false);
    expect(graph.edges[0].requiredLeft).toBe(0b01);
    expect(graph.edges[0].requiredRight).toBe(0b10);
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

describe('HyperGraph resolveJoin connectivity', () => {
  function chain() {
    const graph = new HyperGraph();
    graph.addRelation('A', { type: 'Scan' }, 1);
    graph.addRelation('B', { type: 'Scan' }, 1);
    graph.addRelation('C', { type: 'Scan' }, 1);
    graph.addEdge(['A'], ['B'], { id: 'ab' });
    graph.addEdge(['B'], ['C'], { id: 'bc' });
    return graph;
  }

  it('resolves a join between directly connected relations', () => {
    expect(chain().resolveJoin(0b001, 0b010)).not.toBeNull();
  });

  it('refuses a join between unconnected relations', () => {
    expect(chain().resolveJoin(0b001, 0b100)).toBeNull();
  });

  it('resolves a join when one side is a grouped subplan', () => {
    expect(chain().resolveJoin(0b011, 0b100)).not.toBeNull();
  });

  it('always carries at least one predicate when it resolves an inner join', () => {
    const graph = chain();
    for (let left = 1; left <= graph.fullMask; left++) {
      const right = graph.fullMask & ~left;
      if (right === 0) continue;
      const resolution = graph.resolveJoin(left, right);
      if (resolution) expect(resolution.predicates.length).toBeGreaterThan(0);
    }
  });
});

describe('HyperEdge spans', () => {
  it('accepts a pair that straddles the edge', () => {
    expect(innerEdge(0b01, 0b10).spans(0b01, 0b10)).toBe(true);
  });

  it('accepts the reversed orientation', () => {
    expect(innerEdge(0b01, 0b10).spans(0b10, 0b01)).toBe(true);
  });

  it('rejects a pair that leaves part of the edge outside', () => {
    expect(innerEdge(0b011, 0b100).spans(0b001, 0b100)).toBe(false);
  });

  it('rejects a pair that keeps the whole edge on one side', () => {
    expect(innerEdge(0b01, 0b10).spans(0b11, 0b100)).toBe(false);
  });
});
