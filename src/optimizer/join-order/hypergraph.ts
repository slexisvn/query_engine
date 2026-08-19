import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import { collectTableRefs } from '../expr-walk.js';
import type { LogicalPlanNode } from '../../planner/logical-plan.js';
import type { DefaultCardinalityEstimator } from './cardinality.js';

export const BITMASK_RELATION_CAPACITY = 30;

const DISAMBIGUATOR = '#';

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
  fullMask: number;
  predicate: BoundExpr;

  constructor(leftMask: number, rightMask: number, predicate: BoundExpr) {
    this.leftMask = leftMask;
    this.rightMask = rightMask;
    this.fullMask = leftMask | rightMask;
    this.predicate = predicate;
  }

  spans(leftSide: number, rightSide: number): boolean {
    if ((this.fullMask & (leftSide | rightSide)) !== this.fullMask) return false;
    const forward = (this.leftMask & leftSide) !== 0 && (this.rightMask & rightSide) !== 0;
    const reversed = (this.leftMask & rightSide) !== 0 && (this.rightMask & leftSide) !== 0;
    return forward || reversed;
  }
}

export class HyperGraph {
  relations: RelationEntry[];
  relationIndex: Map<string, number>;
  edges: HyperEdge[];
  adjacency: number[];
  edgesByAnchor: HyperEdge[][];
  adjacencyUnionCache: Map<number, number>;
  unrepresentedPredicates: BoundExpr[];

  constructor() {
    this.relations = [];
    this.relationIndex = new Map();
    this.edges = [];
    this.adjacency = [];
    this.edgesByAnchor = [];
    this.adjacencyUnionCache = new Map();
    this.unrepresentedPredicates = [];
  }

  addRelation(name: string, plan: LogicalPlanNode, cardinality: number): number {
    const id = this.relations.length;
    if (id >= BITMASK_RELATION_CAPACITY) return -1;
    const mask = 1 << id;
    const requested = name.toUpperCase();
    const key = this.relationIndex.has(requested) ? `${requested}${DISAMBIGUATOR}${id}` : requested;
    this.relations.push({ id, name: key, plan, cardinality, mask });
    this.relationIndex.set(key, id);
    this.adjacency.push(0);
    this.edgesByAnchor.push([]);
    this.adjacencyUnionCache.clear();
    return id;
  }

  addEdge(leftNames: string[], rightNames: string[], predicate: BoundExpr): boolean {
    const leftMask = this.maskOfNames(leftNames);
    const rightMask = this.maskOfNames(rightNames);
    if (leftMask === 0 || rightMask === 0 || (leftMask & rightMask) !== 0) return false;

    const edge = new HyperEdge(leftMask, rightMask, predicate);
    this.edges.push(edge);
    this.edgesByAnchor[lowestBitIndex(edge.fullMask)].push(edge);

    for (const i of bitIndices(leftMask)) this.adjacency[i] |= rightMask;
    for (const i of bitIndices(rightMask)) this.adjacency[i] |= leftMask;
    this.adjacencyUnionCache.clear();
    return true;
  }

  maskOfNames(names: string[]): number {
    let mask = 0;
    for (const name of names) {
      const id = this.relationIndex.get(name.toUpperCase());
      if (id !== undefined) mask |= (1 << id);
    }
    return mask;
  }

  adjacencyUnion(subset: number): number {
    const cached = this.adjacencyUnionCache.get(subset);
    if (cached !== undefined) return cached;

    let union = 0;
    let remaining = subset;
    while (remaining !== 0) {
      const bit = remaining & -remaining;
      union |= this.adjacency[31 - Math.clz32(bit)];
      remaining ^= bit;
    }

    this.adjacencyUnionCache.set(subset, union);
    return union;
  }

  neighborhood(subset: number, excluded: number): number {
    return this.adjacencyUnion(subset) & ~subset & ~excluded;
  }

  isConnected(subset: number): boolean {
    if (subset === 0) return false;
    let reached = subset & -subset;
    let frontier = reached;

    while (frontier !== 0) {
      const discovered = this.adjacencyUnion(frontier) & subset & ~reached;
      reached |= discovered;
      frontier = discovered;
    }

    return reached === subset;
  }

  findJoinPredicates(leftMask: number, rightMask: number): BoundExpr[] {
    const preds: BoundExpr[] = [];
    let remaining = leftMask | rightMask;
    while (remaining !== 0) {
      const bit = remaining & -remaining;
      for (const edge of this.edgesByAnchor[31 - Math.clz32(bit)]) {
        if (edge.spans(leftMask, rightMask)) preds.push(edge.predicate);
      }
      remaining ^= bit;
    }
    return preds;
  }

  hasJoinPredicate(leftMask: number, rightMask: number): boolean {
    let remaining = leftMask | rightMask;
    while (remaining !== 0) {
      const bit = remaining & -remaining;
      for (const edge of this.edgesByAnchor[31 - Math.clz32(bit)]) {
        if (edge.spans(leftMask, rightMask)) return true;
      }
      remaining ^= bit;
    }
    return false;
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
    if (!addPredicateEdge(graph, pred)) graph.unrepresentedPredicates.push(pred);
  }

  return graph;
}

function addPredicateEdge(graph: HyperGraph, pred: BoundExpr): boolean {
  const allRefs = collectTableRefs(pred);
  if (allRefs.size < 2) return false;

  if (pred.kind === BoundExprKind.BINARY) {
    const leftRefs = [...collectTableRefs(pred.left)];
    const rightRefs = [...collectTableRefs(pred.right)];
    if (leftRefs.length > 0 && rightRefs.length > 0 && graph.addEdge(leftRefs, rightRefs, pred)) return true;
  }

  const refs = [...allRefs];
  return graph.addEdge([refs[0]], refs.slice(1), pred);
}

export function lowestBitIndex(mask: number): number {
  return 31 - Math.clz32(mask & -mask);
}

export function* bitIndices(mask: number): Generator<number> {
  let remaining = mask;
  while (remaining !== 0) {
    const bit = remaining & -remaining;
    yield 31 - Math.clz32(bit);
    remaining ^= bit;
  }
}

export function popcount(mask: number): number {
  let m = mask - ((mask >> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >> 2) & 0x33333333);
  m = (m + (m >> 4)) & 0x0f0f0f0f;
  return (m * 0x01010101) >> 24;
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

export function descendingBitIndices(mask: number): number[] {
  const indices = [...bitIndices(mask)];
  indices.reverse();
  return indices;
}

export function subsetsByAscendingSize(mask: number): number[] {
  const width = popcount(mask);
  const buckets: number[][] = Array.from({ length: width + 1 }, () => []);
  for (const subset of subsets(mask)) buckets[popcount(subset)].push(subset);

  const ordered: number[] = [];
  for (let size = 1; size <= width; size++) {
    for (const subset of buckets[size]) ordered.push(subset);
  }
  return ordered;
}

export function maskBelowOrEqual(index: number): number {
  return (1 << (index + 1)) - 1;
}
