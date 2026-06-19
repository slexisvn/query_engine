import { BoundExprKind, type BoundExpr, type BoundColumnRefNode, type BoundLiteralNode, type BoundBinaryNode, type BoundBetweenNode, type BoundLikeNode, type BoundInListNode, type BoundIsNullNode, type LiteralValue } from '../../binder/expression-binder.js';
import { PlanNodeType, JoinType, type LogicalPlanNode } from '../../planner/logical-plan.js';

const MIN_SELECTIVITY = 0.0001;
const DEFAULT_CORRELATION = 0.5;
const DEFAULT_NDV = 100;
const DEFAULT_SCAN_ROWS = 1000;

export interface Mcv {
  values: (string | number)[];
  frequencies: number[];
}

export interface Histogram {
  numBuckets: number;
  totalCount: number;
  boundaries: (number | bigint)[];
  bucketCounts: number[];
  bucketDistincts: number[];
  estimateLessThan(value: LiteralValue): number;
  estimateRange(low: LiteralValue, high: LiteralValue): number;
}

export interface ColumnStats {
  ndv?: number;
  nullFraction?: number;
  avgLength?: number;
  min?: number | bigint | string | null;
  max?: number | bigint | string | null;
  mcv?: Mcv;
  histogram?: Histogram;
}

export interface TableStats {
  rowCount: number;
  columnStats?: Map<string, ColumnStats>;
  getCorrelation?(a: string, b: string): number | null;
}

export interface StatsProvider {
  get(key: string): TableStats | undefined;
  values(): IterableIterator<TableStats>;
}

export interface EquiPred {
  left: BoundExpr;
  right: BoundExpr;
}

export class DefaultCardinalityEstimator {
  stats: StatsProvider;

  constructor(statisticsProvider: StatsProvider) {
    this.stats = statisticsProvider;
  }

  estimateScan(tableName: string): number {
    const tableStats = this.stats.get(tableName.toUpperCase());
    return tableStats ? tableStats.rowCount : DEFAULT_SCAN_ROWS;
  }

  estimatePlan(node: LogicalPlanNode | null | undefined): number {
    if (!node) return DEFAULT_SCAN_ROWS;

    switch (node.type) {
      case PlanNodeType.SCAN:
        return this.estimateScan(node.table);
      case PlanNodeType.FILTER:
        return this.estimateFilter(this.estimatePlan(node.children[0]), node.condition);
      case PlanNodeType.PROJECT:
      case PlanNodeType.SORT:
      case PlanNodeType.DISTINCT:
      case PlanNodeType.MATERIALIZE:
        return this.estimatePlan(node.children?.[0]);
      case PlanNodeType.LIMIT: {
        const childCard = this.estimatePlan(node.children?.[0]);
        return Math.min(node.count || childCard, childCard);
      }
      case PlanNodeType.JOIN: {
        const leftCard = this.estimatePlan(node.children[0]);
        const rightCard = this.estimatePlan(node.children[1]);
        if (node.joinType === JoinType.SEMI) return this.estimateSemiJoin(leftCard, rightCard, node.condition);
        if (node.joinType === JoinType.ANTI) return this.estimateAntiJoin(leftCard, rightCard, node.condition);
        if (node.joinType === JoinType.MARK) return leftCard;
        if (node.joinType === JoinType.LEFT) return this.estimateLeftJoin(leftCard, rightCard, node.condition);
        if (node.joinType === JoinType.CROSS) return leftCard * rightCard;
        return this.estimateJoin(leftCard, rightCard, node.condition);
      }
      case PlanNodeType.AGGREGATE:
        return this.estimateAggregate(this.estimatePlan(node.children[0]), node.groupBy?.length || 0, node.groupBy);
      case PlanNodeType.EMPTY:
        return 0;
      default:
        return node.children?.length ? this.estimatePlan(node.children[0]) : DEFAULT_SCAN_ROWS;
    }
  }


  estimateFilter(inputCard: number, predicate: BoundExpr | null): number {
    const sel = this.estimateSelectivity(predicate);
    return Math.max(1, Math.round(inputCard * sel));
  }


  estimateJoin(leftCard: number, rightCard: number, condition: BoundExpr | null): number {
    if (!condition) return leftCard * rightCard;

    const equiPreds = this.extractEquiPredicates(condition);
    if (equiPreds.length === 0) {
      const sel = this.estimateSelectivity(condition);
      return Math.max(1, Math.round(leftCard * rightCard * sel));
    }

    let selectivity = 1.0;
    for (const pred of equiPreds) {
      selectivity *= this.estimateEquiJoinSelectivity(pred.left, pred.right, leftCard, rightCard);
    }

    return Math.max(1, Math.round(leftCard * rightCard * selectivity));
  }

  estimateEquiJoinSelectivity(leftExpr: BoundExpr, rightExpr: BoundExpr, leftCard: number, rightCard: number): number {
    const sA = this.getColumnStats(leftExpr);
    const sB = this.getColumnStats(rightExpr);
    const ndA = Math.min(this.getColumnNdv(leftExpr), leftCard);
    const ndB = Math.min(this.getColumnNdv(rightExpr), rightCard);

    const mcvA = sA?.mcv, mcvB = sB?.mcv;
    const hasMcv = mcvA?.values?.length && mcvB?.values?.length;
    const tailRate = this._histogramJoinCollision(sA, sB);

    if (!hasMcv && tailRate === null) {
      return 1 / Math.max(ndA, ndB, 1);
    }

    let matched = 0, sumMcvA = 0, sumMcvB = 0, mcvLenA = 0, mcvLenB = 0;
    if (hasMcv) {
      const freqB = new Map<string | number, number>();
      for (let i = 0; i < mcvB.values.length; i++) freqB.set(mcvB.values[i], mcvB.frequencies[i]);
      for (let i = 0; i < mcvA.values.length; i++) {
        sumMcvA += mcvA.frequencies[i];
        const fb = freqB.get(mcvA.values[i]);
        if (fb !== undefined) matched += mcvA.frequencies[i] * fb;
      }
      for (let i = 0; i < mcvB.frequencies.length; i++) sumMcvB += mcvB.frequencies[i];
      mcvLenA = mcvA.values.length;
      mcvLenB = mcvB.values.length;
    }

    const otherA = Math.max(0, (1 - (sA?.nullFraction || 0)) - sumMcvA);
    const otherB = Math.max(0, (1 - (sB?.nullFraction || 0)) - sumMcvB);
    const ndOtherA = Math.max(1, ndA - mcvLenA);
    const ndOtherB = Math.max(1, ndB - mcvLenB);
    const rate = tailRate !== null ? tailRate : 1 / Math.max(ndOtherA, ndOtherB);
    const tail = otherA * otherB * rate;

    return Math.max(MIN_SELECTIVITY, Math.min(1, matched + tail));
  }

  _histogramJoinCollision(sA: ColumnStats | null, sB: ColumnStats | null): number | null {
    const hA = sA?.histogram, hB = sB?.histogram;
    if (!hA?.bucketDistincts || !hB?.bucketDistincts || !hA.totalCount || !hB.totalCount) return null;
    const minA = toNumber(sA!.min), minB = toNumber(sB!.min);
    if (minA === null || minB === null) return null;
    return histogramJoinCollision(hA, minA, hB, minB);
  }

  estimateLeftJoin(leftCard: number, rightCard: number, condition: BoundExpr | null): number {
    const innerCard = this.estimateJoin(leftCard, rightCard, condition);
    return Math.max(leftCard, innerCard);
  }

  estimateSemiJoin(leftCard: number, rightCard: number, condition: BoundExpr | null): number {
    if (!condition) return Math.round(leftCard * 0.5);
    const equiPreds = this.extractEquiPredicates(condition);
    if (equiPreds.length > 0) {
      let selectivity = 1.0;
      for (const pred of equiPreds) {
        selectivity = Math.min(selectivity, this.estimateSemiJoinSelectivity(pred.left, pred.right));
      }
      return Math.max(1, Math.round(leftCard * selectivity));
    }
    return Math.max(1, Math.round(leftCard * 0.5));
  }

  estimateSemiJoinSelectivity(leftExpr: BoundExpr, rightExpr: BoundExpr): number {
    const ndvA = this.getColumnNdv(leftExpr);
    const ndvB = this.getColumnNdv(rightExpr);
    const sA = this.getColumnStats(leftExpr);
    const sB = this.getColumnStats(rightExpr);
    const mcvA = sA?.mcv, mcvB = sB?.mcv;
    if (!mcvA?.values?.length || !mcvB?.values?.length) {
      return Math.min(1.0, ndvB / Math.max(ndvA, 1));
    }

    const setB = new Set(mcvB.values);
    let matchfreq = 0, sumMcvA = 0;
    for (let i = 0; i < mcvA.values.length; i++) {
      sumMcvA += mcvA.frequencies[i];
      if (setB.has(mcvA.values[i])) matchfreq += mcvA.frequencies[i];
    }

    const otherA = Math.max(0, (1 - (sA?.nullFraction || 0)) - sumMcvA);
    const ndOtherA = Math.max(1, ndvA - mcvA.values.length);
    const ndOtherB = Math.max(1, ndvB - mcvB.values.length);
    const tailMatch = otherA * Math.min(1, ndOtherB / ndOtherA);
    return Math.max(MIN_SELECTIVITY, Math.min(1, matchfreq + tailMatch));
  }

  estimateAntiJoin(leftCard: number, rightCard: number, condition: BoundExpr | null): number {
    const semiCard = this.estimateSemiJoin(leftCard, rightCard, condition);
    return Math.max(1, leftCard - semiCard);
  }


  estimateAggregate(inputCard: number, groupByCount: number, groupByExprs: BoundExpr[] = []): number {
    if (groupByCount === 0) return 1;

    let ndvProduct = 1;
    const ndvs = (groupByExprs || []).map(expr => this.getColumnNdv(expr)).sort((a, b) => b - a);

    for (let i = 0; i < ndvs.length; i++) {
      if (i === 0) {
        ndvProduct = ndvs[i];
      } else {
        ndvProduct *= Math.max(1, Math.sqrt(ndvs[i]));
      }
    }

    if (ndvProduct > 1) {
      return Math.max(1, Math.min(inputCard, Math.round(ndvProduct)));
    }
    return Math.min(inputCard, Math.pow(10, groupByCount));
  }


  estimateSelectivity(predicate: BoundExpr | null): number {
    if (!predicate) return 1.0;

    switch (predicate.kind) {
      case BoundExprKind.BINARY: {
        if (predicate.op === 'AND') {
          const sl = this.estimateSelectivity(predicate.left);
          const sr = this.estimateSelectivity(predicate.right);
          const independent = sl * sr;
          const correlated = Math.min(sl, sr);
          const correlation = this.lookupCorrelation(predicate.left, predicate.right);
          const blended = independent * (1 - correlation) + correlated * correlation;
          return Math.max(MIN_SELECTIVITY, Math.min(correlated, blended));
        }
        if (predicate.op === 'OR') {
          const sl = this.estimateSelectivity(predicate.left);
          const sr = this.estimateSelectivity(predicate.right);
          return Math.min(1.0, sl + sr - sl * sr);
        }
        if (predicate.op === '=') return this.estimateEqualitySelectivity(predicate);
        if (['<', '>', '<=', '>='].includes(predicate.op)) return this.estimateRangeSelectivity(predicate);
        if (predicate.op === '<>') {
          const eqSel = this.estimateEqualitySelectivity({ ...predicate, op: '=' });
          return Math.max(MIN_SELECTIVITY, 1.0 - eqSel);
        }
        return 0.5;
      }
      case BoundExprKind.BETWEEN:
        return this.estimateBetweenSelectivity(predicate);
      case BoundExprKind.LIKE:
        return this.estimateLikeSelectivity(predicate);
      case BoundExprKind.IN_LIST:
        return this.estimateInListSelectivity(predicate);
      case BoundExprKind.IS_NULL:
        return this.estimateIsNullSelectivity(predicate);
      case BoundExprKind.UNARY:
        if (predicate.op === 'NOT') return Math.max(MIN_SELECTIVITY, 1.0 - this.estimateSelectivity(predicate.operand));
        return 0.5;
      case BoundExprKind.EXISTS:
        return 0.5;
      default:
        return 0.5;
    }
  }

  estimateEqualitySelectivity(predicate: BoundBinaryNode): number {
    let column: BoundColumnRefNode | null = null, literal: BoundLiteralNode | null = null;
    if (predicate.left?.kind === BoundExprKind.COLUMN_REF && predicate.right?.kind === BoundExprKind.LITERAL) {
      column = predicate.left; literal = predicate.right;
    } else if (predicate.right?.kind === BoundExprKind.COLUMN_REF && predicate.left?.kind === BoundExprKind.LITERAL) {
      column = predicate.right; literal = predicate.left;
    } else if (predicate.left?.kind === BoundExprKind.COLUMN_REF && predicate.right?.kind === BoundExprKind.COLUMN_REF) {
      const leftNdv = this.getColumnNdv(predicate.left);
      const rightNdv = this.getColumnNdv(predicate.right);
      return 1.0 / Math.max(leftNdv, rightNdv, 1);
    } else {
      return 0.1;
    }

    const stats = this.getColumnStats(column);
    if (!stats) {
      return 0.1;
    }

    if (stats.mcv) {
      const litStr = String(literal.value);
      const mcvIdx = stats.mcv.values.indexOf(litStr);
      if (mcvIdx >= 0) {
        return stats.mcv.frequencies[mcvIdx] * (1 - (stats.nullFraction || 0));
      }
    }

    const ndv = stats.ndv || DEFAULT_NDV;
    const nullFrac = stats.nullFraction || 0;
    return Math.max(MIN_SELECTIVITY, (1.0 - nullFrac) / ndv);
  }

  estimateRangeSelectivity(predicate: BoundBinaryNode): number {
    const column = predicate.left?.kind === BoundExprKind.COLUMN_REF ? predicate.left : predicate.right;
    const literal = predicate.left?.kind === BoundExprKind.LITERAL ? predicate.left : predicate.right;
    if (column?.kind !== BoundExprKind.COLUMN_REF || literal?.kind !== BoundExprKind.LITERAL) {
      return 0.33;
    }

    const stats = this.getColumnStats(column);
    if (!stats) return 0.33;

    if (stats.histogram) {
      const isLessThan = predicate.left === column
        ? ['<', '<='].includes(predicate.op)
        : ['>', '>='].includes(predicate.op);
      const frac = stats.histogram.estimateLessThan(literal.value);
      const sel = isLessThan ? frac : (1.0 - frac);
      return Math.max(MIN_SELECTIVITY, sel * (1 - (stats.nullFraction || 0)));
    }

    const min = toNumber(stats.min);
    const max = toNumber(stats.max);
    const value = toNumber(literal.value);
    if (min === null || max === null || value === null || max <= min) return 0.33;

    const ratio = (value - min) / (max - min);
    const clamped = Math.max(0, Math.min(1, ratio));
    const lessThan = predicate.left === column
      ? ['<', '<='].includes(predicate.op)
      : ['>', '>='].includes(predicate.op);
    return Math.max(MIN_SELECTIVITY, (lessThan ? clamped : 1 - clamped) * (1 - (stats.nullFraction || 0)));
  }

  estimateBetweenSelectivity(predicate: BoundBetweenNode): number {
    const stats = this.getColumnStats(predicate.expr);
    if (!stats) return 0.25;

    if (stats.histogram && predicate.low?.kind === BoundExprKind.LITERAL && predicate.high?.kind === BoundExprKind.LITERAL) {
      const sel = stats.histogram.estimateRange(predicate.low.value, predicate.high.value);
      const result = predicate.negated ? 1.0 - sel : sel;
      return Math.max(MIN_SELECTIVITY, result * (1 - (stats.nullFraction || 0)));
    }

    const min = toNumber(stats.min);
    const max = toNumber(stats.max);
    const low = toNumber(predicate.low?.kind === BoundExprKind.LITERAL ? predicate.low.value : undefined);
    const high = toNumber(predicate.high?.kind === BoundExprKind.LITERAL ? predicate.high.value : undefined);
    if (min === null || max === null || low === null || high === null || max <= min) return 0.25;

    const covered = Math.max(0, Math.min(max, high) - Math.max(min, low));
    const sel = covered / (max - min);
    return Math.max(MIN_SELECTIVITY, Math.min(1, predicate.negated ? 1 - sel : sel));
  }

  estimateInListSelectivity(predicate: BoundInListNode): number {
    if (Array.isArray(predicate.list)) {
      const ndv = this.getColumnNdv(predicate.expr);
      const stats = this.getColumnStats(predicate.expr);
      const nullFrac = stats?.nullFraction ?? 0;

      if (stats?.mcv) {
        let mcvHits = 0;
        let mcvFreq = 0;
        for (const item of predicate.list) {
          if (item.kind === BoundExprKind.LITERAL) {
            const idx = stats.mcv.values.indexOf(String(item.value));
            if (idx >= 0) {
              mcvHits++;
              mcvFreq += stats.mcv.frequencies[idx];
            }
          }
        }
        const nonMcvItems = predicate.list.length - mcvHits;
        const nonMcvNdv = Math.max(1, ndv - stats.mcv.values.length);
        const nonMcvFreq = nonMcvItems / nonMcvNdv;
        const totalSel = Math.min(1.0, (mcvFreq + nonMcvFreq) * (1 - nullFrac));
        return predicate.negated ? Math.max(MIN_SELECTIVITY, 1 - totalSel) : Math.max(MIN_SELECTIVITY, totalSel);
      }

      const sel = Math.min(1.0, predicate.list.length / Math.max(ndv, 1)) * (1 - nullFrac);
      return predicate.negated ? Math.max(MIN_SELECTIVITY, 1 - sel) : Math.max(MIN_SELECTIVITY, sel);
    }
    return predicate.negated ? 0.7 : 0.3;
  }

  estimateIsNullSelectivity(predicate: BoundIsNullNode): number {
    const stats = this.getColumnStats(predicate.expr);
    const nullFrac = stats?.nullFraction ?? 0.05;
    return predicate.negated ? Math.max(MIN_SELECTIVITY, 1 - nullFrac) : Math.max(MIN_SELECTIVITY, nullFrac);
  }

  estimateLikeSelectivity(predicate: BoundLikeNode): number {
    const pattern = predicate.pattern.kind === BoundExprKind.LITERAL ? predicate.pattern.value : undefined;
    if (typeof pattern !== 'string') return this.likeFallback('unknown');

    const ndv = this.getColumnNdv(predicate.expr);
    const stats = this.getColumnStats(predicate.expr);
    const avgLen = stats?.avgLength;

    if (!pattern.includes('%') && !pattern.includes('_')) {
      return ndv > 0 ? 1 / ndv : this.likeFallback('exact');
    }

    if (this.isPrefixPattern(pattern)) {
      const prefixLen = pattern.length - 1;
      if (avgLen && avgLen > 0) {
        const exponent = Math.min(prefixLen / avgLen, 1);
        return Math.max(MIN_SELECTIVITY, Math.pow(ndv, -exponent));
      }
      return Math.max(MIN_SELECTIVITY, 1 / Math.pow(ndv, Math.min(1, prefixLen / 4)));
    }

    if (this.isContainsPattern(pattern)) {
      const inner = pattern.slice(1, -1);
      if (avgLen && avgLen > 0) {
        const coverageRatio = Math.min(1, inner.length / avgLen);
        const baseSelectivity = 1 / Math.max(Math.sqrt(ndv), 1);
        return Math.max(MIN_SELECTIVITY, baseSelectivity * (1 - coverageRatio * 0.5));
      }
      return Math.max(MIN_SELECTIVITY, 1 / Math.max(Math.sqrt(ndv), 1));
    }

    if (this.isSuffixPattern(pattern)) {
      const suffixLen = pattern.length - 1;
      if (avgLen && avgLen > 0) {
        return Math.max(MIN_SELECTIVITY, 1 / Math.pow(ndv, Math.min(1, suffixLen / avgLen)));
      }
      return Math.max(MIN_SELECTIVITY, 1 / Math.max(Math.sqrt(ndv), 1));
    }

    return this.likeFallback('complex');
  }

  isPrefixPattern(pattern: string): boolean {
    return pattern.endsWith('%') && !pattern.slice(0, -1).includes('%') && !pattern.includes('_');
  }

  isContainsPattern(pattern: string): boolean {
    return pattern.startsWith('%') && pattern.endsWith('%') && !pattern.slice(1, -1).includes('%');
  }

  isSuffixPattern(pattern: string): boolean {
    return pattern.startsWith('%') && !pattern.slice(1).includes('%') && !pattern.includes('_');
  }

  likeFallback(type: string): number {
    const fallbacks: Record<string, number> = { exact: 0.1, unknown: 0.1, complex: 0.15 };
    return fallbacks[type] ?? 0.1;
  }


  lookupCorrelation(leftPred: BoundExpr, rightPred: BoundExpr): number {
    const leftCol = this.extractSingleColumn(leftPred);
    const rightCol = this.extractSingleColumn(rightPred);
    if (!leftCol || !rightCol) return DEFAULT_CORRELATION;
    if (leftCol.tableAlias?.toUpperCase() !== rightCol.tableAlias?.toUpperCase()) return DEFAULT_CORRELATION;

    const tableStats = this.stats.get(leftCol.tableAlias.toUpperCase());
    if (!tableStats?.getCorrelation) return DEFAULT_CORRELATION;

    const corr = tableStats.getCorrelation(leftCol.columnName, rightCol.columnName);
    return corr !== null ? Math.abs(corr) : DEFAULT_CORRELATION;
  }

  extractSingleColumn(pred: BoundExpr): BoundColumnRefNode | null {
    if (pred?.kind === BoundExprKind.COLUMN_REF) return pred;
    if (pred?.kind === BoundExprKind.BINARY && ['=', '<', '>', '<=', '>=', '<>'].includes(pred.op)) {
      if (pred.left?.kind === BoundExprKind.COLUMN_REF) return pred.left;
      if (pred.right?.kind === BoundExprKind.COLUMN_REF) return pred.right;
    }
    if (pred?.kind === BoundExprKind.BETWEEN && pred.expr?.kind === BoundExprKind.COLUMN_REF) return pred.expr;
    if (pred?.kind === BoundExprKind.LIKE && pred.expr?.kind === BoundExprKind.COLUMN_REF) return pred.expr;
    if (pred?.kind === BoundExprKind.IN_LIST && pred.expr?.kind === BoundExprKind.COLUMN_REF) return pred.expr;
    return null;
  }

  getColumnNdv(expr: BoundExpr): number {
    if (expr?.kind !== BoundExprKind.COLUMN_REF) return DEFAULT_NDV;
    const colStats = this.getColumnStats(expr);
    return colStats?.ndv || DEFAULT_NDV;
  }

  getColumnStats(expr: BoundExpr | null): ColumnStats | null {
    if (!expr) return null;
    if (expr.kind !== BoundExprKind.COLUMN_REF) return null;

    const columnName = expr.columnName?.toUpperCase();
    const tableStats = this.stats.get(expr.tableAlias?.toUpperCase());
    if (tableStats?.columnStats?.has(columnName)) {
      return tableStats.columnStats.get(columnName) ?? null;
    }

    for (const stats of this.stats.values()) {
      if (stats.columnStats?.has(columnName)) {
        return stats.columnStats.get(columnName) ?? null;
      }
    }
    return null;
  }


  extractEquiPredicates(condition: BoundExpr | null): EquiPred[] {
    const result: EquiPred[] = [];
    this._collectEqui(condition, result);
    return result;
  }

  _collectEqui(expr: BoundExpr | null, result: EquiPred[]): void {
    if (!expr) return;
    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
      this._collectEqui(expr.left, result);
      this._collectEqui(expr.right, result);
      return;
    }
    if (expr.kind === BoundExprKind.BINARY && expr.op === '='
        && expr.left?.kind === BoundExprKind.COLUMN_REF
        && expr.right?.kind === BoundExprKind.COLUMN_REF) {
      result.push({ left: expr.left, right: expr.right });
    }
  }
}

interface BucketRanges {
  lows: (number | null)[];
  highs: (number | null)[];
}

function toNumber(value: number | bigint | string | boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return null;
}

function bucketRanges(hist: Histogram, colMin: number): BucketRanges {
  const lows: (number | null)[] = new Array(hist.numBuckets);
  const highs: (number | null)[] = new Array(hist.numBuckets);
  for (let i = 0; i < hist.numBuckets; i++) {
    lows[i] = i === 0 ? colMin : toNumber(hist.boundaries[i - 1]);
    highs[i] = toNumber(hist.boundaries[i]);
  }
  return { lows, highs };
}

function findBucket(ranges: BucketRanges, value: number): number {
  const { highs } = ranges;
  let lo = 0, hi = highs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (highs[mid]! >= value) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans >= 0 && value >= ranges.lows[ans]! ? ans : -1;
}

function segFraction(ranges: BucketRanges, idx: number, segWidth: number): number {
  const bw = ranges.highs[idx]! - ranges.lows[idx]!;
  return bw > 0 ? Math.min(1, segWidth / bw) : 1;
}

function histogramJoinCollision(hA: Histogram, minA: number, hB: Histogram, minB: number): number {
  const A = bucketRanges(hA, minA);
  const B = bucketRanges(hB, minB);
  const lo = Math.max(A.lows[0]!, B.lows[0]!);
  const hi = Math.min(A.highs[hA.numBuckets - 1]!, B.highs[hB.numBuckets - 1]!);
  if (hi <= lo) return 0;

  const points = new Set<number>([lo, hi]);
  for (let i = 0; i < hA.numBuckets; i++) if (A.highs[i]! > lo && A.highs[i]! < hi) points.add(A.highs[i]!);
  for (let i = 0; i < hB.numBuckets; i++) if (B.highs[i]! > lo && B.highs[i]! < hi) points.add(B.highs[i]!);
  const pts = [...points].sort((x, y) => x - y);

  const totA = hA.totalCount, totB = hB.totalCount;
  let collision = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const p = pts[s], q = pts[s + 1];
    const width = q - p;
    const ai = findBucket(A, (p + q) / 2);
    const bi = findBucket(B, (p + q) / 2);
    if (ai < 0 || bi < 0) continue;
    const fracA = segFraction(A, ai, width);
    const fracB = segFraction(B, bi, width);
    const rowsA = hA.bucketCounts[ai] * fracA;
    const rowsB = hB.bucketCounts[bi] * fracB;
    const dA = Math.max(1, hA.bucketDistincts[ai] * fracA);
    const dB = Math.max(1, hB.bucketDistincts[bi] * fracB);
    collision += (rowsA / totA) * (rowsB / totB) / Math.max(dA, dB);
  }
  return Math.max(0, Math.min(1, collision));
}
