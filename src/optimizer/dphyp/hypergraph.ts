import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import type { LogicalPlanNode } from '../../planner/logical-plan.js';
import type { DefaultCardinalityEstimator } from './cardinality.js';

export interface Relation {
  name: string;
  alias?: string;
  plan: LogicalPlanNode;
}

export interface RelationEntry {
  id: number;
  name: string;
  plan: LogicalPlanNode;
  cardinality: number;
  mask: number;
}

export class HyperEdge {
  leftMask: number;
  rightMask: number;
  predicate: BoundExpr;

  constructor(leftMask: number, rightMask: number, predicate: BoundExpr) {
    this.leftMask = leftMask;
    this.rightMask = rightMask;
    this.predicate = predicate;
  }
}

export class HyperGraph {
  relations: RelationEntry[];
  relationIndex: Map<string, number>;
  edges: HyperEdge[];
  adjacency: number[];

  constructor() {
    this.relations = [];
    this.relationIndex = new Map();
    this.edges = [];
    this.adjacency = [];
  }

  addRelation(name: string, plan: LogicalPlanNode, cardinality: number): number {
    const id = this.relations.length;
    if (id >= 30) return -1;
    const mask = 1 << id;
    this.relations.push({ id, name, plan, cardinality, mask });
    this.relationIndex.set(name.toUpperCase(), id);
    this.adjacency.push(0);
    return id;
  }

  addEdge(leftNames: string[], rightNames: string[], predicate: BoundExpr): void {
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

  getNeighborhood(subset: number): number {
    let neighbors = 0;
    for (let i = 0; i < this.relations.length; i++) {
      if (subset & (1 << i)) {
        neighbors |= this.adjacency[i];
      }
    }
    return neighbors & ~subset;
  }

  isConnected(subset: number): boolean {
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

  findJoinPredicates(leftMask: number, rightMask: number): BoundExpr[] {
    const preds: BoundExpr[] = [];
    const seen = new Set<HyperEdge>();
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

  get size(): number {
    return this.relations.length;
  }

  get fullMask(): number {
    return (1 << this.relations.length) - 1;
  }
}

export function buildHyperGraph(relations: Relation[], joinPredicates: BoundExpr[], cardinalityEstimator: DefaultCardinalityEstimator): HyperGraph {
  const graph = new HyperGraph();

  for (const rel of relations) {
    const card = cardinalityEstimator.estimatePlan
      ? cardinalityEstimator.estimatePlan(rel.plan)
      : cardinalityEstimator.estimateScan(rel.name);
    const id = graph.addRelation(rel.alias || rel.name, rel.plan, card);
    if (id === -1) return graph;
  }

  for (const pred of joinPredicates) {
    const allRefs = collectColumnTableRefs(pred);
    if (allRefs.size < 2) continue;

    let leftRefs: string[] = [];
    let rightRefs: string[] = [];
    if (pred.kind === BoundExprKind.BINARY) {
      leftRefs = [...collectColumnTableRefs(pred.left)];
      rightRefs = [...collectColumnTableRefs(pred.right)];
    }

    if (leftRefs.length > 0 && rightRefs.length > 0) {
      graph.addEdge(leftRefs, rightRefs, pred);
    } else {
      const refsArray = [...allRefs];
      graph.addEdge([refsArray[0]], refsArray.slice(1), pred);
    }
  }

  return graph;
}

function collectColumnTableRefs(expr: BoundExpr): Set<string> {
  const refs = new Set<string>();
  _walkExpr(expr, (e: BoundExpr) => {
    if (e.kind === BoundExprKind.COLUMN_REF && e.tableAlias) {
      refs.add(e.tableAlias.toUpperCase());
    }
  });
  return refs;
}

function _walkExpr(expr: BoundExpr | null | undefined, fn: (e: BoundExpr) => void): void {
  if (!expr) return;
  fn(expr);
  switch (expr.kind) {
    case BoundExprKind.BINARY:
      _walkExpr(expr.left, fn);
      _walkExpr(expr.right, fn);
      return;
    case BoundExprKind.UNARY:
      _walkExpr(expr.operand, fn);
      return;
    case BoundExprKind.FUNCTION:
    case BoundExprKind.AGGREGATE:
      for (const a of expr.args) _walkExpr(a, fn);
      return;
  }
}

function lowestBit(mask: number): number {
  return mask & (-mask);
}

export function popcount(mask: number): number {
  let count = 0;
  while (mask) {
    count += mask & 1;
    mask >>>= 1;
  }
  return count;
}

export function subsets(mask: number): number[] {
  const result: number[] = [];
  let s = mask;
  while (s > 0) {
    result.push(s);
    s = (s - 1) & mask;
  }
  return result;
}
