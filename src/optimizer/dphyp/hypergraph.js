import { BoundExprKind } from '../../binder/expression-binder.js';

export class HyperEdge {
  constructor(leftMask, rightMask, predicate) {
    this.leftMask = leftMask;
    this.rightMask = rightMask;
    this.predicate = predicate;
  }
}

export class HyperGraph {
  constructor() {
    this.relations = [];
    this.relationIndex = new Map();
    this.edges = [];
    this.adjacency = [];
  }

  addRelation(name, plan, cardinality) {
    const id = this.relations.length;
    if (id >= 30) return -1;
    const mask = 1 << id;
    this.relations.push({ id, name, plan, cardinality, mask });
    this.relationIndex.set(name.toUpperCase(), id);
    this.adjacency.push(0);
    return id;
  }

  addEdge(leftNames, rightNames, predicate) {
    let leftMask = 0;
    for (const name of leftNames) {
      const id = this.relationIndex.get(name.toUpperCase());
      if (id !== undefined) leftMask |= (1 << id);
    }

    let rightMask = 0;
    for (const name of rightNames) {
      const id = this.relationIndex.get(name.toUpperCase());
      if (id !== undefined) rightMask |= (1 << id);
    }

    if (leftMask === 0 || rightMask === 0) return;

    this.edges.push(new HyperEdge(leftMask, rightMask, predicate));

    for (let i = 0; i < this.relations.length; i++) {
      const bit = 1 << i;
      if (leftMask & bit) this.adjacency[i] |= rightMask;
      if (rightMask & bit) this.adjacency[i] |= leftMask;
    }
  }

  getNeighborhood(subset) {
    let neighbors = 0;
    for (let i = 0; i < this.relations.length; i++) {
      if (subset & (1 << i)) {
        neighbors |= this.adjacency[i];
      }
    }
    return neighbors & ~subset;
  }

  isConnected(subset) {
    if (subset === 0) return false;
    const startBit = lowestBit(subset);
    let reached = startBit;
    let frontier = startBit;

    while (frontier !== 0) {
      let nextFrontier = 0;
      for (let i = 0; i < this.relations.length; i++) {
        if (!(frontier & (1 << i))) continue;
        const adj = this.adjacency[i] & subset & ~reached;
        nextFrontier |= adj;
        reached |= adj;
      }
      frontier = nextFrontier;
    }

    return reached === subset;
  }

  findJoinPredicates(leftMask, rightMask) {
    const preds = [];
    const seen = new Set();
    for (const edge of this.edges) {
      const edgeFull = edge.leftMask | edge.rightMask;
      const combined = leftMask | rightMask;
      if ((edgeFull & combined) !== edgeFull) continue;
      const matchNormal = (edge.leftMask & leftMask) !== 0
        && (edge.rightMask & rightMask) !== 0;
      const matchFlipped = (edge.leftMask & rightMask) !== 0
        && (edge.rightMask & leftMask) !== 0;
      if ((matchNormal || matchFlipped) && !seen.has(edge)) {
        seen.add(edge);
        preds.push(edge.predicate);
      }
    }
    return preds;
  }

  get size() {
    return this.relations.length;
  }

  get fullMask() {
    return (1 << this.relations.length) - 1;
  }
}

export function buildHyperGraph(relations, joinPredicates, cardinalityEstimator) {
  const graph = new HyperGraph();

  for (const rel of relations) {
    const card = cardinalityEstimator.estimatePlan
      ? cardinalityEstimator.estimatePlan(rel.plan)
      : cardinalityEstimator.estimateScan(rel.name);
    const id = graph.addRelation(rel.alias || rel.name, rel.plan, card);
    if (id === -1) return graph;
  }

  for (const pred of joinPredicates) {
    const refs = collectColumnTableRefs(pred);
    if (refs.size < 2) continue;

    const refsArray = [...refs];
    for (let i = 0; i < refsArray.length; i++) {
      for (let j = i + 1; j < refsArray.length; j++) {
        graph.addEdge([refsArray[i]], [refsArray[j]], pred);
      }
    }
  }

  return graph;
}

function collectColumnTableRefs(expr) {
  const refs = new Set();
  _walkExpr(expr, e => {
    if (e.kind === BoundExprKind.COLUMN_REF && e.tableAlias) {
      refs.add(e.tableAlias.toUpperCase());
    }
  });
  return refs;
}

function _walkExpr(expr, fn) {
  if (!expr || typeof expr !== 'object') return;
  fn(expr);
  if (expr.left) _walkExpr(expr.left, fn);
  if (expr.right) _walkExpr(expr.right, fn);
  if (expr.operand) _walkExpr(expr.operand, fn);
  if (expr.args) for (const a of expr.args) _walkExpr(a, fn);
}

function lowestBit(mask) {
  return mask & (-mask);
}

export function popcount(mask) {
  let count = 0;
  while (mask) {
    count += mask & 1;
    mask >>>= 1;
  }
  return count;
}

export function subsets(mask) {
  const result = [];
  let s = mask;
  while (s > 0) {
    result.push(s);
    s = (s - 1) & mask;
  }
  return result;
}
