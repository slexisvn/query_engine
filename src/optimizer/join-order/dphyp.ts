import { subsetsByAscendingSize, descendingBitIndices, lowestBitIndex, maskBelowOrEqual } from './bitmask.js';
import type { HyperGraph, JoinResolution } from './hypergraph.js';
import { bestJoinOf, type JoinCardinalityEstimator, type JoinEnumerator, type JoinOrderEntry } from './join-plan.js';
import { Config } from '../../config.js';
import type { DefaultCostModel } from '../../planner/cost-model.js';

export class DPhypEnumerator implements JoinEnumerator {
  graph: HyperGraph;
  costModel: DefaultCostModel;
  cardEstimator: JoinCardinalityEstimator;
  dp: Map<number, JoinOrderEntry>;
  pairBudget: number;
  pairsEmitted: number;
  budgetExhausted: boolean;

  constructor(
    hyperGraph: HyperGraph,
    costModel: DefaultCostModel,
    cardinalityEstimator: JoinCardinalityEstimator,
    pairBudget: number = Config.joinOrderMaxPairs,
  ) {
    this.graph = hyperGraph;
    this.costModel = costModel;
    this.cardEstimator = cardinalityEstimator;
    this.dp = new Map();
    this.pairBudget = pairBudget;
    this.pairsEmitted = 0;
    this.budgetExhausted = false;
  }

  get name(): string {
    return 'DPhyp';
  }

  get exhaustive(): boolean {
    return true;
  }

  solve(): JoinOrderEntry | null {
    this.seedLeaves();

    for (let index = this.graph.size - 1; index >= 0; index--) {
      const seed = 1 << index;
      this.emitCsg(seed);
      if (this.budgetExhausted) return null;
      this.enumerateCsgRec(seed, maskBelowOrEqual(index));
      if (this.budgetExhausted) return null;
    }

    return this.dp.get(this.graph.fullMask) ?? null;
  }

  seedLeaves(): void {
    for (const rel of this.graph.relations) {
      this.dp.set(rel.mask, {
        plan: rel.plan,
        cardinality: rel.cardinality,
        totalCost: this.costModel.scanCost(rel.cardinality),
        mask: rel.mask,
      });
    }
  }

  enumerateCsgRec(subset: number, excluded: number): void {
    const neighborhood = this.graph.neighborhood(subset, excluded);
    if (neighborhood === 0) return;

    const expansions = subsetsByAscendingSize(neighborhood);

    for (const expansion of expansions) {
      if (this.dp.has(subset | expansion)) this.emitCsg(subset | expansion);
      if (this.budgetExhausted) return;
    }

    const nextExcluded = excluded | neighborhood;
    for (const expansion of expansions) {
      this.enumerateCsgRec(subset | expansion, nextExcluded);
      if (this.budgetExhausted) return;
    }
  }

  emitCsg(subset: number): void {
    const excluded = subset | maskBelowOrEqual(lowestBitIndex(subset));
    const neighborhood = this.graph.neighborhood(subset, excluded);

    for (const index of descendingBitIndices(neighborhood)) {
      const complement = 1 << index;
      const resolution = this.graph.resolveJoin(subset, complement);
      if (resolution) this.emitCsgCmp(subset, complement, resolution);
      if (this.budgetExhausted) return;
      this.enumerateCmpRec(subset, complement, excluded | (maskBelowOrEqual(index) & neighborhood));
      if (this.budgetExhausted) return;
    }
  }

  enumerateCmpRec(left: number, right: number, excluded: number): void {
    const neighborhood = this.graph.neighborhood(right, excluded);
    if (neighborhood === 0) return;

    const expansions = subsetsByAscendingSize(neighborhood);

    for (const expansion of expansions) {
      const grown = right | expansion;
      if (this.dp.has(grown)) {
        const resolution = this.graph.resolveJoin(left, grown);
        if (resolution) this.emitCsgCmp(left, grown, resolution);
      }
      if (this.budgetExhausted) return;
    }

    const nextExcluded = excluded | neighborhood;
    for (const expansion of expansions) {
      this.enumerateCmpRec(left, right | expansion, nextExcluded);
      if (this.budgetExhausted) return;
    }
  }

  emitCsgCmp(left: number, right: number, resolution: JoinResolution): void {
    if (++this.pairsEmitted > this.pairBudget) {
      this.budgetExhausted = true;
      return;
    }

    const leftEntry = this.dp.get(left);
    const rightEntry = this.dp.get(right);
    if (!leftEntry || !rightEntry) return;

    const candidate = bestJoinOf(leftEntry, rightEntry, resolution, this.costModel, this.cardEstimator);
    const existing = this.dp.get(candidate.mask);
    if (!existing || candidate.totalCost < existing.totalCost) {
      this.dp.set(candidate.mask, candidate);
    }
  }
}
