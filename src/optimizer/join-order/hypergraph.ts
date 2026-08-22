import type { BoundExpr } from '../../binder/expression-binder.js';
import { JoinType, type LogicalJoinNode, type LogicalPlanNode } from '../../planner/logical-plan.js';
import type { DefaultCardinalityEstimator } from '../../planner/cardinality.js';
import { BITMASK_RELATION_CAPACITY, bitIndices, lowestBitIndex } from './bitmask.js';
import { JOIN_TYPE_PROPERTIES, type JoinConstraint, type JoinPredicateEntry } from './join-conflicts.js';

const DISAMBIGUATOR = '#';

function isSingleRelation(mask: number): boolean {
  return mask !== 0 && (mask & (mask - 1)) === 0;
}

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

export interface HyperEdgeSpec {
  joinType: JoinType;
  source: LogicalJoinNode | null;
  predicate: BoundExpr | null;
  leftMask: number;
  rightMask: number;
  requiredLeft: number;
  requiredRight: number;
  tesMask: number;
}

export class HyperEdge {
  joinType: JoinType;
  source: LogicalJoinNode | null;
  predicate: BoundExpr | null;
  leftMask: number;
  rightMask: number;
  requiredLeft: number;
  requiredRight: number;
  connectLeft: number;
  connectRight: number;
  fullMask: number;
  simple: boolean;
  conjunctive: boolean;

  constructor(spec: HyperEdgeSpec) {
    this.joinType = spec.joinType;
    this.source = spec.source;
    this.predicate = spec.predicate;
    this.leftMask = spec.leftMask;
    this.rightMask = spec.rightMask;
    this.requiredLeft = spec.requiredLeft;
    this.requiredRight = spec.requiredRight;
    this.connectLeft = spec.leftMask | (spec.requiredLeft & ~spec.rightMask);
    this.connectRight = spec.rightMask | (spec.requiredRight & ~spec.leftMask);
    this.fullMask = this.connectLeft | this.connectRight;
    this.simple = isSingleRelation(this.connectLeft) && isSingleRelation(this.connectRight);
    this.conjunctive = JOIN_TYPE_PROPERTIES[spec.joinType].conjunctive;
  }

  representativeNeighbors(subset: number, forbidden: number): number {
    let neighbors = 0;
    if ((this.connectLeft & ~subset) === 0 && (this.connectRight & forbidden) === 0) {
      neighbors |= this.connectRight & -this.connectRight;
    }
    if ((this.connectRight & ~subset) === 0 && (this.connectLeft & forbidden) === 0) {
      neighbors |= this.connectLeft & -this.connectLeft;
    }
    return neighbors;
  }

  spans(leftSide: number, rightSide: number): boolean {
    if ((this.fullMask & (leftSide | rightSide)) !== this.fullMask) return false;

    const connecting = this.leftMask | this.rightMask;
    if ((connecting & leftSide) === 0 || (connecting & rightSide) === 0) return false;

    return this.fitsForward(leftSide, rightSide) || this.fitsForward(rightSide, leftSide);
  }

  fitsForward(leftSide: number, rightSide: number): boolean {
    return (this.requiredLeft & ~leftSide) === 0 && (this.requiredRight & ~rightSide) === 0;
  }

  requiredAt(leftSide: number, rightSide: number): boolean {
    if ((this.fullMask & (leftSide | rightSide)) !== this.fullMask) return false;
    return (this.fullMask & leftSide) !== 0 && (this.fullMask & rightSide) !== 0;
  }
}

export interface JoinResolution {
  joinType: JoinType;
  source: LogicalJoinNode | null;
  predicates: BoundExpr[];
  swapped: boolean;
}

export function innerEdgeSpec(leftMask: number, rightMask: number, predicate: BoundExpr): HyperEdgeSpec {
  return {
    joinType: JoinType.INNER,
    source: null,
    predicate,
    leftMask,
    rightMask,
    requiredLeft: 0,
    requiredRight: 0,
    tesMask: leftMask | rightMask,
  };
}

export function constraintEdgeSpec(constraint: JoinConstraint, entry: JoinPredicateEntry): HyperEdgeSpec {
  const { operator, conflictMask, leftTes, rightTes } = constraint;
  const shared = {
    joinType: operator.joinType,
    source: operator.source,
    predicate: entry.predicate,
    leftMask: entry.leftMask,
    rightMask: entry.rightMask,
  };

  if (!JOIN_TYPE_PROPERTIES[operator.joinType].conjunctive) {
    return { ...shared, requiredLeft: leftTes, requiredRight: rightTes, tesMask: leftTes | rightTes };
  }

  return {
    ...shared,
    requiredLeft: conflictMask & ~entry.sesMask & operator.leftRels,
    requiredRight: conflictMask & ~entry.sesMask & operator.rightRels,
    tesMask: entry.sesMask | conflictMask,
  };
}

export class HyperGraph {
  relations: RelationEntry[];
  relationIndex: Map<string, number>;
  edges: HyperEdge[];
  complexEdges: HyperEdge[];
  adjacency: number[];
  edgesByAnchor: HyperEdge[][];
  adjacencyUnionCache: Map<number, number>;

  constructor() {
    this.relations = [];
    this.relationIndex = new Map();
    this.edges = [];
    this.complexEdges = [];
    this.adjacency = [];
    this.edgesByAnchor = [];
    this.adjacencyUnionCache = new Map();
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
    return this.addOperatorEdge(new HyperEdge(innerEdgeSpec(leftMask, rightMask, predicate)));
  }

  addOperatorEdge(edge: HyperEdge): boolean {
    if (edge.leftMask === 0 || edge.rightMask === 0) return false;

    this.edges.push(edge);
    this.edgesByAnchor[lowestBitIndex(edge.fullMask)].push(edge);

    if (edge.simple) {
      this.adjacency[lowestBitIndex(edge.connectLeft)] |= edge.connectRight;
      this.adjacency[lowestBitIndex(edge.connectRight)] |= edge.connectLeft;
    } else {
      this.complexEdges.push(edge);
    }

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
    for (const index of bitIndices(subset)) union |= this.adjacency[index];

    this.adjacencyUnionCache.set(subset, union);
    return union;
  }

  neighborhood(subset: number, excluded: number): number {
    const forbidden = subset | excluded;
    let neighbors = this.adjacencyUnion(subset);
    for (const edge of this.complexEdges) neighbors |= edge.representativeNeighbors(subset, forbidden);
    return neighbors & ~forbidden;
  }

  isConnected(subset: number): boolean {
    if (subset === 0) return false;
    let reached = subset & -subset;

    for (;;) {
      let grown = reached | (this.adjacencyUnion(reached) & subset);
      for (const edge of this.complexEdges) {
        if ((edge.fullMask & ~subset) === 0 && (edge.fullMask & reached) !== 0) grown |= edge.fullMask;
      }
      if (grown === reached) return reached === subset;
      reached = grown;
    }
  }

  resolveJoin(leftMask: number, rightMask: number): JoinResolution | null {
    let operator: HyperEdge | null = null;
    const predicates: BoundExpr[] = [];
    let required = 0;

    for (const index of bitIndices(leftMask | rightMask)) {
      for (const edge of this.edgesByAnchor[index]) {
        if (!edge.requiredAt(leftMask, rightMask)) continue;
        if (!edge.spans(leftMask, rightMask)) return null;

        required++;
        if (edge.conjunctive) {
          if (edge.predicate) predicates.push(edge.predicate);
        } else if (operator) {
          return null;
        } else {
          operator = edge;
        }
      }
    }

    if (required === 0) return null;
    if (!operator) return { joinType: JoinType.INNER, source: null, predicates, swapped: false };
    if (required > 1) return null;

    return {
      joinType: operator.joinType,
      source: operator.source,
      predicates: operator.predicate ? [operator.predicate] : [],
      swapped: !operator.fitsForward(leftMask, rightMask),
    };
  }

  get size(): number {
    return this.relations.length;
  }

  get fullMask(): number {
    return (1 << this.relations.length) - 1;
  }
}

export function buildJoinHyperGraph(
  relations: Relation[],
  constraints: JoinConstraint[],
  cardinalityEstimator: DefaultCardinalityEstimator,
): HyperGraph {
  const graph = new HyperGraph();

  for (const rel of relations) {
    const card = cardinalityEstimator.estimatePlan
      ? cardinalityEstimator.estimatePlan(rel.plan)
      : cardinalityEstimator.estimateScan(rel.name);
    if (graph.addRelation(rel.alias || rel.name, rel.plan, card) === -1) return graph;
  }

  for (const constraint of constraints) {
    for (const entry of constraint.operator.predicates) {
      graph.addOperatorEdge(new HyperEdge(constraintEdgeSpec(constraint, entry)));
    }
  }

  return graph;
}
