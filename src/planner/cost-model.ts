import { Config } from '../config.js';
import { DataType } from '../storage/data-type.js';

export enum SortKeyClass {
  RADIX = 'Radix',
  NUMERIC = 'Numeric',
  TEXT = 'Text',
}

const RADIX_TYPES: ReadonlySet<DataType> = new Set([DataType.INT32, DataType.DATE]);

export function sortKeyClassOf(types: readonly (DataType | null | undefined)[]): SortKeyClass {
  if (types.length === 0) return SortKeyClass.NUMERIC;
  if (types.some(type => type === DataType.VARCHAR)) return SortKeyClass.TEXT;
  if (types.length === 1 && types[0] !== null && types[0] !== undefined && RADIX_TYPES.has(types[0])) {
    return SortKeyClass.RADIX;
  }
  return SortKeyClass.NUMERIC;
}

export interface CostModelOptions {
  tupleCost?: number;
  operatorCost?: number;
  bufferCost?: number;
  rowAssemblyCost?: number;
  hashProbeCost?: number;
  hashInsertCost?: number;
  ioCost?: number;
  comparisonCost?: number;
  textComparisonFactor?: number;
  radixPasses?: number;
  spillThreshold?: number;
  crossJoinPenalty?: number;
}

export class DefaultCostModel {
  C_TUPLE: number;
  C_OPERATOR: number;
  C_BUFFER: number;
  C_ROW: number;
  C_HASH: number;
  C_HASH_INSERT: number;
  C_IO: number;
  C_COMPARE: number;
  C_TEXT: number;
  RADIX_PASSES: number;
  SPILL_THRESHOLD: number;
  C_CROSS: number;

  constructor(options: CostModelOptions = {}) {
    this.C_TUPLE = options.tupleCost ?? Config.costTuple;
    this.C_OPERATOR = options.operatorCost ?? Config.costOperator;
    this.C_BUFFER = options.bufferCost ?? Config.costBuffer;
    this.C_ROW = options.rowAssemblyCost ?? Config.costRowAssembly;
    this.C_HASH = options.hashProbeCost ?? Config.costHashProbe;
    this.C_HASH_INSERT = options.hashInsertCost ?? Config.costHashInsert;
    this.C_IO = options.ioCost ?? Config.costIo;
    this.C_COMPARE = options.comparisonCost ?? Config.costComparison;
    this.C_TEXT = options.textComparisonFactor ?? Config.costTextComparisonFactor;
    this.RADIX_PASSES = options.radixPasses ?? Config.costRadixPasses;

    this.SPILL_THRESHOLD = options.spillThreshold ?? Config.costModelSpillThreshold;
    this.C_CROSS = options.crossJoinPenalty ?? Config.costCrossJoinPenalty;
  }

  spillPenalty(residentCard: number, streamedCard: number): number {
    if (residentCard <= this.SPILL_THRESHOLD) return 0;
    return streamedCard * (1 - this.SPILL_THRESHOLD / residentCard) * this.C_IO;
  }

  scanCost(card: number): number {
    return card * this.C_TUPLE;
  }

  filterCost(card: number): number {
    return card * (this.C_TUPLE + this.C_OPERATOR);
  }

  comparisonCost(keyClass: SortKeyClass): number {
    return keyClass === SortKeyClass.TEXT ? this.C_COMPARE * this.C_TEXT : this.C_COMPARE;
  }

  sortCost(card: number, keyClass: SortKeyClass = SortKeyClass.NUMERIC): number {
    if (card <= 1) return 0;
    const buffered = card * (this.C_TUPLE + this.C_BUFFER);
    const ordered = keyClass === SortKeyClass.RADIX && card >= Config.radixSortMinRows
      ? card * this.C_OPERATOR * this.RADIX_PASSES
      : card * Math.log2(card) * this.comparisonCost(keyClass);
    return buffered + ordered + this.spillPenalty(card, card);
  }

  topNSortCost(card: number, limit: number, keyClass: SortKeyClass = SortKeyClass.NUMERIC): number {
    if (card <= 1 || limit <= 0) return 0;
    const kept = Math.min(limit, card);
    const scanned = card * this.C_TUPLE;
    const compared = card * Math.log2(Math.max(2, kept)) * this.comparisonCost(keyClass);
    return scanned + compared + kept * this.C_BUFFER + this.spillPenalty(kept, card);
  }

  hashBuildCost(buildCard: number): number {
    return buildCard * (this.C_TUPLE + this.C_HASH_INSERT);
  }

  hashProbeCost(probeCard: number): number {
    return probeCard * (this.C_TUPLE + this.C_HASH);
  }

  joinOutputCost(outputCard: number): number {
    return outputCard * (this.C_ROW + this.C_OPERATOR);
  }

  hashJoinCost(buildCard: number, probeCard: number, outputCard: number | null = null): number {
    const emitted = outputCard ?? Math.max(buildCard, probeCard);
    return this.hashBuildCost(buildCard)
      + this.hashProbeCost(probeCard)
      + this.joinOutputCost(emitted)
      + this.spillPenalty(buildCard, buildCard + probeCard);
  }

  rescannedTuples(leftCard: number, rightCard: number, outputCard: number): number {
    return Math.max(0, outputCard - Math.max(leftCard, rightCard));
  }

  mergeJoinCost(leftCard: number, rightCard: number, outputCard: number | null = null, keyClass: SortKeyClass = SortKeyClass.NUMERIC): number {
    const emitted = outputCard ?? Math.max(leftCard, rightCard);
    const compare = this.comparisonCost(keyClass);
    const walked = (leftCard + rightCard) * (this.C_TUPLE + this.C_ROW + compare);
    const revisited = this.rescannedTuples(leftCard, rightCard, emitted) * (this.C_TUPLE + compare);
    return walked + revisited + this.joinOutputCost(emitted);
  }

  sortMergeJoinCost(leftCard: number, rightCard: number, outputCard: number | null = null, keyClass: SortKeyClass = SortKeyClass.NUMERIC): number {
    return this.sortCost(leftCard, keyClass)
      + this.sortCost(rightCard, keyClass)
      + this.mergeJoinCost(leftCard, rightCard, outputCard, keyClass);
  }

  mergeJoinCostWithSorts(leftCard: number, rightCard: number, leftSorted: boolean, rightSorted: boolean, outputCard: number, keyClass: SortKeyClass = SortKeyClass.NUMERIC): number {
    const leftSortCost = leftSorted ? 0 : this.sortCost(leftCard, keyClass);
    const rightSortCost = rightSorted ? 0 : this.sortCost(rightCard, keyClass);
    return leftSortCost + rightSortCost + this.mergeJoinCost(leftCard, rightCard, outputCard, keyClass);
  }

  nestedLoopJoinCost(outerCard: number, innerCard: number): number {
    return outerCard * innerCard * this.C_OPERATOR;
  }

  blockNestedLoopJoinCost(buildCard: number, probeCard: number, outputCard: number | null = null): number {
    const emitted = outputCard ?? Math.max(buildCard, probeCard);
    const buffered = (buildCard + probeCard) * (this.C_TUPLE + this.C_ROW);
    return buffered
      + this.nestedLoopJoinCost(buildCard, probeCard)
      + this.joinOutputCost(emitted)
      + this.spillPenalty(buildCard, buildCard + probeCard);
  }

  crossJoinCost(leftCard: number, rightCard: number): number {
    return leftCard * rightCard * this.C_CROSS;
  }

  hashAggregateCost(card: number, numGroups: number | null = null): number {
    const groups = numGroups ?? Math.max(1, Math.sqrt(card));
    const consumed = card * (this.C_TUPLE + this.C_HASH + this.C_OPERATOR);
    return consumed + groups * this.C_ROW + this.spillPenalty(groups, card);
  }

  aggregateCost(card: number): number {
    return this.hashAggregateCost(card);
  }

  streamAggregateCost(card: number): number {
    return card * (this.C_TUPLE + this.C_OPERATOR);
  }

  totalJoinCost(buildPlan: { totalCost: number }, probePlan: { totalCost: number }, buildCard: number, probeCard: number, outputCard: number): number {
    return buildPlan.totalCost + probePlan.totalCost + this.hashJoinCost(buildCard, probeCard, outputCard);
  }
}
