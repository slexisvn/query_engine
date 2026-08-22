import { bestJoinOf, type JoinCardinalityEstimator, type JoinEnumerator, type JoinOrderEntry } from './join-plan.js';
import type { HyperGraph } from './hypergraph.js';
import type { DefaultCostModel } from '../../planner/cost-model.js';

export class GreedyJoinEnumerator implements JoinEnumerator {
  graph: HyperGraph;
  costModel: DefaultCostModel;
  cardEstimator: JoinCardinalityEstimator;

  constructor(hyperGraph: HyperGraph, costModel: DefaultCostModel, cardinalityEstimator: JoinCardinalityEstimator) {
    this.graph = hyperGraph;
    this.costModel = costModel;
    this.cardEstimator = cardinalityEstimator;
  }

  get name(): string {
    return 'GreedyJoinOrder';
  }

  get exhaustive(): boolean {
    return false;
  }

  solve(): JoinOrderEntry | null {
    const remaining = new Map<number, JoinOrderEntry>();
    for (const rel of this.graph.relations) {
      remaining.set(rel.mask, {
        plan: rel.plan,
        cardinality: rel.cardinality,
        totalCost: this.costModel.scanCost(rel.cardinality),
        mask: rel.mask,
      });
    }

    while (remaining.size > 1) {
      const best = this.cheapestConnectedPair(remaining);
      if (!best) return null;

      remaining.delete(best.leftMask);
      remaining.delete(best.rightMask);
      remaining.set(best.entry.mask, best.entry);
    }

    const [only] = remaining.values();
    return only && only.mask === this.graph.fullMask ? only : null;
  }

  cheapestConnectedPair(remaining: Map<number, JoinOrderEntry>): GreedyPair | null {
    const bySourceRelation = this.indexBySourceRelation(remaining);
    let best: GreedyPair | null = null;

    for (const edge of this.graph.edges) {
      const leftMask = this.enclosingMask(bySourceRelation, edge.leftMask);
      const rightMask = this.enclosingMask(bySourceRelation, edge.rightMask);
      if (leftMask === null || rightMask === null || leftMask === rightMask) continue;

      const left = remaining.get(leftMask)!;
      const right = remaining.get(rightMask)!;
      const resolution = this.graph.resolveJoin(leftMask, rightMask);
      if (!resolution) continue;

      const entry = bestJoinOf(left, right, resolution, this.costModel, this.cardEstimator);
      if (!best || entry.cardinality < best.entry.cardinality
        || (entry.cardinality === best.entry.cardinality && entry.totalCost < best.entry.totalCost)) {
        best = { leftMask, rightMask, entry };
      }
    }

    return best;
  }

  indexBySourceRelation(remaining: Map<number, JoinOrderEntry>): Map<number, number> {
    const index = new Map<number, number>();
    for (const mask of remaining.keys()) {
      let bits = mask;
      while (bits !== 0) {
        const bit = bits & -bits;
        index.set(bit, mask);
        bits ^= bit;
      }
    }
    return index;
  }

  enclosingMask(bySourceRelation: Map<number, number>, edgeSide: number): number | null {
    let enclosing: number | null = null;
    let bits = edgeSide;
    while (bits !== 0) {
      const bit = bits & -bits;
      const owner = bySourceRelation.get(bit);
      if (owner === undefined) return null;
      if (enclosing === null) enclosing = owner;
      else if (enclosing !== owner) return null;
      bits ^= bit;
    }
    return enclosing;
  }
}

interface GreedyPair {
  leftMask: number;
  rightMask: number;
  entry: JoinOrderEntry;
}
