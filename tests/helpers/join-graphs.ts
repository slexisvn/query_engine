import { HyperGraph } from '../../src/optimizer/join-order/hypergraph.js';
import { bestJoinOf } from '../../src/optimizer/join-order/join-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

export function makeColRef(table, column) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column };
}

export function makeEqPred(leftTable, leftCol, rightTable, rightCol) {
  return {
    kind: BoundExprKind.BINARY,
    op: '=',
    left: makeColRef(leftTable, leftCol),
    right: makeColRef(rightTable, rightCol),
  };
}

export function relationName(index) {
  return String.fromCharCode(65 + index);
}

export function buildGraph(cardinalities, edges) {
  const graph = new HyperGraph();
  cardinalities.forEach((card, i) => {
    const name = relationName(i);
    graph.addRelation(name, { type: 'Scan', table: name }, card);
  });
  for (const [left, right] of edges) {
    graph.addEdge(
      [relationName(left)],
      [relationName(right)],
      makeEqPred(relationName(left), 'id', relationName(right), 'fk'),
    );
  }
  return graph;
}

export function chainEdges(size) {
  return Array.from({ length: size - 1 }, (_, i) => [i, i + 1]);
}

export function starEdges(size) {
  return Array.from({ length: size - 1 }, (_, i) => [0, i + 1]);
}

export function cycleEdges(size) {
  return [...chainEdges(size), [size - 1, 0]];
}

export function cliqueEdges(size) {
  const edges = [];
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) edges.push([i, j]);
  }
  return edges;
}

export function proportionalEstimator() {
  return {
    estimateJoin(leftCard, rightCard, condition) {
      if (!condition) return leftCard * rightCard;
      return Math.max(1, Math.round((leftCard * rightCard) / 1000));
    },
  };
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function popcount(mask) {
  let count = 0;
  while (mask) { count += mask & 1; mask >>>= 1; }
  return count;
}

export function bruteForceOptimum(graph, costModel, estimator) {
  const dp = new Map();
  for (const rel of graph.relations) {
    dp.set(rel.mask, {
      plan: rel.plan,
      cardinality: rel.cardinality,
      totalCost: costModel.scanCost(rel.cardinality),
      mask: rel.mask,
    });
  }

  const full = graph.fullMask;
  for (let size = 2; size <= graph.size; size++) {
    for (let mask = 1; mask <= full; mask++) {
      if (popcount(mask) !== size) continue;
      if (!graph.isConnected(mask)) continue;

      for (let left = (mask - 1) & mask; left > 0; left = (left - 1) & mask) {
        const right = mask & ~left;
        if (right === 0) continue;
        const leftEntry = dp.get(left);
        const rightEntry = dp.get(right);
        if (!leftEntry || !rightEntry) continue;

        const predicates = graph.findJoinPredicates(left, right);
        if (predicates.length === 0) continue;

        const candidate = bestJoinOf(leftEntry, rightEntry, predicates, costModel, estimator);
        const existing = dp.get(mask);
        if (!existing || candidate.totalCost < existing.totalCost) dp.set(mask, candidate);
      }
    }
  }

  return dp.get(full) ?? null;
}
