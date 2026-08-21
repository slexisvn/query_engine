export interface CostModelOptions {
  hashBuildCost?: number;
  hashProbeCost?: number;
  compareCost?: number;
  scanCost?: number;
  filterCost?: number;
  outputCost?: number;
  memoryCost?: number;
  ioCost?: number;
  spillThreshold?: number;
  crossJoinPenalty?: number;
}

export class DefaultCostModel {
  C_HASH_BUILD: number;
  C_HASH_PROBE: number;
  C_COMPARE: number;
  C_SCAN: number;
  C_FILTER: number;
  C_OUTPUT: number;
  C_MEMORY: number;
  C_IO: number;
  SPILL_THRESHOLD: number;
  C_CROSS: number;

  constructor(options: CostModelOptions = {}) {
    this.C_HASH_BUILD = options.hashBuildCost ?? 1.5;
    this.C_HASH_PROBE = options.hashProbeCost ?? 1.0;
    this.C_COMPARE = options.compareCost ?? 0.3;
    this.C_SCAN = options.scanCost ?? 0.1;
    this.C_FILTER = options.filterCost ?? 0.2;
    this.C_OUTPUT = options.outputCost ?? 0.3;

    this.C_MEMORY = options.memoryCost ?? 0.05;
    this.C_IO = options.ioCost ?? 5.0;
    this.SPILL_THRESHOLD = options.spillThreshold ?? 200000;

    this.C_CROSS = options.crossJoinPenalty ?? 1000;
  }

  hashJoinCost(buildCard: number, probeCard: number, outputCard: number | null = null): number {
    const cpu = buildCard * this.C_HASH_BUILD + probeCard * this.C_HASH_PROBE;
    const mem = buildCard * this.C_MEMORY;
    const out = (outputCard || Math.max(buildCard, probeCard)) * this.C_OUTPUT;
    const spill = buildCard > this.SPILL_THRESHOLD
      ? (buildCard + probeCard) * this.C_IO
      : 0;
    return cpu + mem + out + spill;
  }

  mergeJoinCost(leftCard: number, rightCard: number, outputCard: number | null = null): number {
    const cpu = (leftCard + rightCard) * this.C_COMPARE;
    const out = (outputCard || Math.max(leftCard, rightCard)) * this.C_OUTPUT;
    return cpu + out;
  }

  sortMergeJoinCost(leftCard: number, rightCard: number, outputCard: number | null = null): number {
    return this.sortCost(leftCard) + this.sortCost(rightCard) +
           this.mergeJoinCost(leftCard, rightCard, outputCard);
  }

  nestedLoopJoinCost(outerCard: number, innerCard: number): number {
    return outerCard * innerCard * this.C_COMPARE;
  }

  blockNestedLoopJoinCost(buildCard: number, probeCard: number, outputCard: number | null = null): number {
    const build = buildCard * this.C_HASH_BUILD + buildCard * this.C_MEMORY;
    const compare = this.nestedLoopJoinCost(buildCard, probeCard);
    const out = (outputCard || Math.max(buildCard, probeCard)) * this.C_OUTPUT;
    const spill = buildCard > this.SPILL_THRESHOLD ? (buildCard + probeCard) * this.C_IO : 0;
    return build + compare + out + spill;
  }

  crossJoinCost(leftCard: number, rightCard: number): number {
    return leftCard * rightCard * this.C_CROSS;
  }

  sortCost(card: number): number {
    if (card <= 1) return 0;
    return card * Math.log2(card) * this.C_COMPARE;
  }

  topNSortCost(card: number, limit: number): number {
    if (card <= 1 || limit <= 0) return 0;
    const k = Math.min(limit, card);
    return card * Math.log2(Math.max(2, k)) * this.C_COMPARE;
  }

  scanCost(card: number): number {
    return card * this.C_SCAN;
  }

  filterCost(card: number): number {
    return card * this.C_FILTER;
  }

  aggregateCost(card: number): number {
    return this.hashAggregateCost(card);
  }

  hashAggregateCost(card: number, numGroups: number | null = null): number {
    const groups = numGroups || Math.max(1, Math.sqrt(card));
    return card * this.C_HASH_BUILD + groups * this.C_MEMORY;
  }

  streamAggregateCost(card: number): number {
    return card * this.C_SCAN;
  }

  totalJoinCost(buildPlan: { totalCost: number }, probePlan: { totalCost: number }, buildCard: number, probeCard: number, outputCard: number): number {
    return buildPlan.totalCost + probePlan.totalCost +
           this.hashJoinCost(buildCard, probeCard, outputCard);
  }

  mergeJoinCostWithSorts(leftCard: number, rightCard: number, leftSorted: boolean, rightSorted: boolean, outputCard: number): number {
    const leftSortCost = leftSorted ? 0 : this.sortCost(leftCard);
    const rightSortCost = rightSorted ? 0 : this.sortCost(rightCard);
    return leftSortCost + rightSortCost + this.mergeJoinCost(leftCard, rightCard, outputCard);
  }
}
