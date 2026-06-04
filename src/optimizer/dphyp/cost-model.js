export class DefaultCostModel {
  constructor(options = {}) {
    this.C_HASH_BUILD = options.hashBuildCost ?? 1.5;  
    this.C_HASH_PROBE = options.hashProbeCost ?? 1.0;  
    this.C_COMPARE = options.compareCost ?? 0.5;       
    this.C_SCAN = options.scanCost ?? 0.1;             
    this.C_FILTER = options.filterCost ?? 0.2;         
    this.C_OUTPUT = options.outputCost ?? 0.3;         

    this.C_MEMORY = options.memoryCost ?? 0.05;

    this.C_CROSS = options.crossJoinPenalty ?? 1000;
  }

  hashJoinCost(buildCard, probeCard, outputCard = null) {
    const cpu = buildCard * this.C_HASH_BUILD + probeCard * this.C_HASH_PROBE;
    const mem = buildCard * this.C_MEMORY;
    const out = (outputCard || Math.max(buildCard, probeCard)) * this.C_OUTPUT;
    return cpu + mem + out;
  }

  mergeJoinCost(leftCard, rightCard, outputCard = null) {
    const cpu = (leftCard + rightCard) * this.C_COMPARE;
    const out = (outputCard || Math.max(leftCard, rightCard)) * this.C_OUTPUT;
    return cpu + out;
  }

  sortMergeJoinCost(leftCard, rightCard, outputCard = null) {
    return this.sortCost(leftCard) + this.sortCost(rightCard) +
           this.mergeJoinCost(leftCard, rightCard, outputCard);
  }

  nestedLoopJoinCost(outerCard, innerCard) {
    return outerCard * innerCard * this.C_COMPARE;
  }

  crossJoinCost(leftCard, rightCard) {
    return leftCard * rightCard * this.C_CROSS;
  }

  sortCost(card) {
    if (card <= 1) return 0;
    return card * Math.log2(card) * this.C_COMPARE;
  }

  topNSortCost(card, limit) {
    if (card <= 1 || limit <= 0) return 0;
    const k = Math.min(limit, card);
    return card * Math.log2(Math.max(2, k)) * this.C_COMPARE;
  }

  scanCost(card) {
    return card * this.C_SCAN;
  }

  filterCost(card) {
    return card * this.C_FILTER;
  }

  aggregateCost(card) {
    return this.hashAggregateCost(card);
  }

  hashAggregateCost(card, numGroups = null) {
    const groups = numGroups || Math.max(1, Math.sqrt(card));
    return card * this.C_HASH_BUILD + groups * this.C_MEMORY;
  }

  streamAggregateCost(card) {
    return card * this.C_SCAN;
  }

  totalJoinCost(buildPlan, probePlan, buildCard, probeCard) {
    const joinCard = Math.max(1, Math.round(buildCard * probeCard * 0.1)); 
    return buildPlan.totalCost + probePlan.totalCost +
           this.hashJoinCost(buildCard, probeCard, joinCard);
  }

  cheaperJoinCost(leftCard, rightCard, leftSorted, rightSorted, outputCard) {
    const hashCost = this.hashJoinCost(
      Math.min(leftCard, rightCard),
      Math.max(leftCard, rightCard),
      outputCard
    );
    const mergeCost = (leftSorted && rightSorted)
      ? this.mergeJoinCost(leftCard, rightCard, outputCard)
      : this.sortMergeJoinCost(leftCard, rightCard, outputCard);

    return { hashCost, mergeCost, preferMerge: mergeCost < hashCost };
  }
}
