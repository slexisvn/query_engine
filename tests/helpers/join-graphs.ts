import { HyperEdge, HyperGraph } from '../../src/optimizer/join-order/hypergraph.js';
import { JOIN_TYPE_PROPERTIES, JoinTreeNodeKind } from '../../src/optimizer/join-order/join-conflicts.js';
import { PlanNodeType } from '../../src/planner/logical-plan.js';
import { bestJoinOf } from '../../src/optimizer/join-order/join-plan.js';
import { JoinType } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

export function innerResolution(predicates) {
  return { joinType: JoinType.INNER, source: null, predicates, swapped: false };
}

export function addJoinEdge(graph, joinType, leftNames, rightNames, predicate, required = {}) {
  const leftMask = graph.maskOfNames(leftNames);
  const rightMask = graph.maskOfNames(rightNames);
  const conjunctive = JOIN_TYPE_PROPERTIES[joinType].conjunctive;
  return graph.addOperatorEdge(new HyperEdge({
    joinType,
    source: null,
    predicate,
    leftMask,
    rightMask,
    requiredLeft: required.left ?? (conjunctive ? 0 : leftMask),
    requiredRight: required.right ?? (conjunctive ? 0 : rightMask),
    tesMask: (required.tes ?? 0) | leftMask | rightMask,
  }));
}

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

const PROPORTIONAL_JOIN_RULES = {
  INNER: (l, r, c) => proportionalInner(l, r, c),
  CROSS: (l, r) => l * r,
  LEFT: (l, r, c) => Math.max(l, proportionalInner(l, r, c)),
  RIGHT: (l, r, c) => Math.max(r, proportionalInner(l, r, c)),
  FULL: (l, r, c) => Math.max(l, r, proportionalInner(l, r, c)),
  SEMI: (l) => Math.max(1, Math.round(l / 2)),
  ANTI: (l) => Math.max(1, Math.round(l / 2)),
  MARK: (l) => l,
  SINGLE: (l) => l,
};

function proportionalInner(leftCard, rightCard, condition) {
  if (!condition) return leftCard * rightCard;
  return Math.max(1, Math.round((leftCard * rightCard) / 1000));
}

export function proportionalEstimator() {
  return {
    estimateJoinOf(joinType, leftCard, rightCard, condition) {
      return PROPORTIONAL_JOIN_RULES[joinType](leftCard, rightCard, condition);
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

        const resolution = graph.resolveJoin(left, right);
        if (!resolution) continue;

        const candidate = bestJoinOf(leftEntry, rightEntry, resolution, costModel, estimator);
        const existing = dp.get(mask);
        if (!existing || candidate.totalCost < existing.totalCost) dp.set(mask, candidate);
      }
    }
  }

  return dp.get(full) ?? null;
}

export function relationLeaf(index) {
  return { kind: JoinTreeNodeKind.RELATION, mask: 1 << index };
}

export function treeRelations(node) {
  return node.kind === JoinTreeNodeKind.RELATION ? node.mask : node.leftRels | node.rightRels;
}

export function predicateEntry(predicate, sesMask, leftMask, rightMask) {
  return { predicate, sesMask, leftMask, rightMask };
}

export function operatorNode(joinType, left, right, entries, condition = null) {
  const leftRels = treeRelations(left);
  const rightRels = treeRelations(right);
  const sesMask = entries.reduce((mask, entry) => mask | entry.sesMask, 0);
  return {
    kind: JoinTreeNodeKind.OPERATOR,
    joinType,
    source: { type: PlanNodeType.JOIN, joinType, condition, children: [] },
    predicates: entries,
    left,
    right,
    leftRels,
    rightRels,
    sesMask,
    nullRejectedMask: 0,
  };
}

export function scanRelations(names) {
  return names.map(name => ({ name, alias: name, plan: { type: PlanNodeType.SCAN, table: name, alias: name } }));
}

export function buildHyperEdgeGraph(cardinalities, edges) {
  const graph = new HyperGraph();
  cardinalities.forEach((card, i) => {
    const name = relationName(i);
    graph.addRelation(name, { type: PlanNodeType.SCAN, table: name }, card);
  });
  for (const [left, right] of edges) {
    graph.addEdge(
      left.map(relationName),
      right.map(relationName),
      makeEqPred(relationName(left[0]), 'id', relationName(right[0]), 'fk'),
    );
  }
  return graph;
}
