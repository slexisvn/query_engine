import { DataType, toNumericValue, type ColumnValue, type ColumnSchema } from '../storage/data-type.js';
import { Config } from '../config.js';
import { hashValue } from '../utils/hash.js';
import { HyperLogLog } from './hyperloglog.js';
import { SpaceSavingCounter } from './space-saving.js';
import { ReservoirSample, deterministicRandom } from './reservoir-sample.js';

const UNKNOWN_FRACTION = 0.5;

export interface Mcv {
  values: (string | number)[];
  frequencies: number[];
}

export interface ColumnStatisticsInit {
  ndv?: number;
  min?: ColumnValue;
  max?: ColumnValue;
  nullFraction?: number;
  histogram?: EquiDepthHistogram | null;
  mcv?: Mcv | null;
  avgWidth?: number;
  avgLength?: number | null;
}

export interface HistogramLike {
  numBuckets: number;
  totalCount: number | null;
  lowerBound: ColumnValue;
  boundaries: ColumnValue[];
  bucketCounts: number[] | null;
  bucketDistincts: number[] | null;
  estimateLessThan(value: ColumnValue): number;
  estimateRange(low: ColumnValue, high: ColumnValue): number;
}

export interface ColumnStats {
  ndv?: number;
  nullFraction?: number;
  avgLength?: number | null;
  min?: ColumnValue;
  max?: ColumnValue;
  mcv?: Mcv | null;
  histogram?: HistogramLike | null;
}

export interface TableStats {
  rowCount: number;
  columnStats?: Map<string, ColumnStats>;
  getColumnStats?(columnName: string): ColumnStats | null;
  getCorrelation?(colA: string, colB: string): number | null;
}

export interface StatsProvider {
  get(key: string): TableStats | undefined;
  values(): IterableIterator<TableStats>;
}

export interface HistogramBucketInfo {
  boundaries: ColumnValue[];
  bucketCounts: number[] | null;
  bucketDistincts: number[] | null;
}

export class ColumnStatistics {
  ndv: number;
  min: ColumnValue;
  max: ColumnValue;
  nullFraction: number;
  histogram: EquiDepthHistogram | null;
  mcv: Mcv | null;
  avgWidth: number;
  avgLength: number | null;

  constructor({ ndv = 0, min = null, max = null, nullFraction = 0, histogram = null, mcv = null, avgWidth = 8, avgLength = null }: ColumnStatisticsInit = {}) {
    this.ndv = ndv;
    this.min = min;
    this.max = max;
    this.nullFraction = nullFraction;
    this.histogram = histogram;
    this.mcv = mcv;
    this.avgWidth = avgWidth;
    this.avgLength = avgLength;
  }
}

export class TableStatistics {
  rowCount: number;
  columnStats: Map<string, ColumnStatistics>;
  correlations: Map<string, number>;

  constructor(rowCount: number, columnStats: Map<string, ColumnStatistics> = new Map(), correlations: Map<string, number> = new Map()) {
    this.rowCount = rowCount;
    this.columnStats = columnStats;
    this.correlations = correlations;
  }

  getColumnStats(columnName: string): ColumnStatistics | null {
    return this.columnStats.get(columnName.toUpperCase()) || null;
  }

  setColumnStats(columnName: string, stats: ColumnStatistics): void {
    this.columnStats.set(columnName.toUpperCase(), stats);
  }

  _correlationKey(colA: string, colB: string): string {
    const a = colA.toUpperCase();
    const b = colB.toUpperCase();
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  getCorrelation(colA: string, colB: string): number | null {
    return this.correlations.get(this._correlationKey(colA, colB)) ?? null;
  }

  setCorrelation(colA: string, colB: string, value: number): void {
    this.correlations.set(this._correlationKey(colA, colB), value);
  }

  get avgRowWidth(): number {
    let width = 0;
    for (const cs of this.columnStats.values()) {
      width += cs.avgWidth || 8;
    }
    return width || 64;
  }
}

export interface EquiDepthHistogramInit {
  lowerBound?: ColumnValue;
  bucketCounts?: number[] | null;
  bucketDistincts?: number[] | null;
}

export class EquiDepthHistogram {
  boundaries: ColumnValue[];
  lowerBound: ColumnValue;
  numBuckets: number;
  bucketCounts: number[] | null;
  bucketDistincts: number[] | null;
  totalCount: number | null;
  cumulativeCounts: number[] | null;

  constructor(boundaries: ColumnValue[], { lowerBound, bucketCounts = null, bucketDistincts = null }: EquiDepthHistogramInit = {}) {
    this.boundaries = boundaries;
    this.lowerBound = lowerBound ?? boundaries[0] ?? null;
    this.numBuckets = boundaries.length;
    this.bucketCounts = bucketCounts;
    this.bucketDistincts = bucketDistincts;
    this.totalCount = bucketCounts ? bucketCounts.reduce((a, b) => a + b, 0) : null;
    this.cumulativeCounts = bucketCounts ? prefixSums(bucketCounts) : null;
  }

  bucketInfo(): HistogramBucketInfo {
    return { boundaries: this.boundaries, bucketCounts: this.bucketCounts, bucketDistincts: this.bucketDistincts };
  }

  bucketOf(value: number): number {
    let lo = 0, hi = this.numBuckets - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (toNumericValue(this.boundaries[mid])! < value) lo = mid + 1;
      else hi = mid - 1;
    }
    return lo;
  }

  bucketLowerBound(bucket: number): number | null {
    return bucket === 0 ? toNumericValue(this.lowerBound) : toNumericValue(this.boundaries[bucket - 1]);
  }

  cumulativeFraction(bucket: number, fractionWithin: number): number {
    if (this.cumulativeCounts && this.bucketCounts && this.totalCount) {
      const rows = this.cumulativeCounts[bucket] + fractionWithin * this.bucketCounts[bucket];
      return Math.max(0, Math.min(1, rows / this.totalCount));
    }
    return Math.max(0, Math.min(1, (bucket + fractionWithin) / this.numBuckets));
  }

  estimateLessThan(value: ColumnValue): number {
    if (this.numBuckets === 0) return UNKNOWN_FRACTION;
    const target = toNumericValue(value);
    if (target === null) return UNKNOWN_FRACTION;

    const lowest = toNumericValue(this.lowerBound);
    if (lowest !== null && target <= lowest) return 0;

    const bucket = this.bucketOf(target);
    if (bucket >= this.numBuckets) return 1;

    const bucketMin = this.bucketLowerBound(bucket);
    const bucketMax = toNumericValue(this.boundaries[bucket]);
    if (bucketMin === null || bucketMax === null) return UNKNOWN_FRACTION;

    const range = bucketMax - bucketMin;
    const fractionWithin = range > 0
      ? Math.max(0, Math.min(1, (target - bucketMin) / range))
      : UNKNOWN_FRACTION;

    return this.cumulativeFraction(bucket, fractionWithin);
  }

  estimateEqual(value: ColumnValue): number {
    const target = toNumericValue(value);
    if (target === null || this.numBuckets === 0) return 0;
    if (!this.bucketCounts || !this.bucketDistincts || !this.totalCount) return 0;

    const bucket = this.bucketOf(target);
    if (bucket >= this.numBuckets) return 0;

    const bucketMin = this.bucketLowerBound(bucket);
    if (bucketMin === null || target < bucketMin) return 0;

    const distincts = Math.max(1, this.bucketDistincts[bucket]);
    return (this.bucketCounts[bucket] / distincts) / this.totalCount;
  }

  estimateRange(low: ColumnValue, high: ColumnValue): number {
    const span = this.estimateLessThan(high) - this.estimateLessThan(low);
    return Math.max(0, Math.min(1, span + this.estimateEqual(high)));
  }
}

function prefixSums(counts: number[]): number[] {
  const sums = new Array<number>(counts.length);
  let running = 0;
  for (let i = 0; i < counts.length; i++) {
    sums[i] = running;
    running += counts[i];
  }
  return sums;
}

export interface TableStatsSource {
  rowCount(): number;
  getSchema(): ColumnSchema[];
  getColumnIndex(name: string): number;
  scan(): AsyncIterable<{ size: number; getValue(row: number, col: number): ColumnValue }>;
}

const NUMERIC_TYPES: ReadonlySet<DataType> = new Set([
  DataType.INT32, DataType.INT64, DataType.FLOAT64, DataType.DECIMAL, DataType.DATE, DataType.TIMESTAMP,
]);

const CORRELATION_TYPES: ReadonlySet<DataType> = new Set([
  DataType.INT32, DataType.INT64, DataType.FLOAT64, DataType.DECIMAL,
]);

interface ColumnAccumulator {
  name: string;
  index: number;
  numeric: boolean;
  nullCount: number;
  nonNullCount: number;
  min: ColumnValue;
  max: ColumnValue;
  totalWidth: number;
  totalLength: number;
  stringCount: number;
  distinct: HyperLogLog;
  frequent: SpaceSavingCounter;
  sample: ReservoirSample<number>;
}

function valueWidth(value: ColumnValue): number {
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'bigint') return 8;
  return 4;
}

function createAccumulator(column: ColumnSchema, index: number): ColumnAccumulator {
  return {
    name: column.name.toUpperCase(),
    index,
    numeric: NUMERIC_TYPES.has(column.dataType),
    nullCount: 0,
    nonNullCount: 0,
    min: null,
    max: null,
    totalWidth: 0,
    totalLength: 0,
    stringCount: 0,
    distinct: new HyperLogLog(Config.statsHllPrecision),
    frequent: new SpaceSavingCounter(Config.statsMcvCount * Config.statsMcvOversample),
    sample: new ReservoirSample<number>(Config.statsSampleRows, deterministicRandom(index + 1)),
  };
}

function observe(acc: ColumnAccumulator, value: ColumnValue): void {
  if (value === null || value === undefined) {
    acc.nullCount++;
    return;
  }

  acc.nonNullCount++;
  acc.distinct.addHash(hashValue(value));
  acc.frequent.add(String(value));
  acc.totalWidth += valueWidth(value);

  if (typeof value === 'string') {
    acc.totalLength += value.length;
    acc.stringCount++;
  }

  if (acc.min === null || value < acc.min) acc.min = value;
  if (acc.max === null || value > acc.max) acc.max = value;

  if (acc.numeric) {
    const numeric = toNumericValue(value);
    if (numeric !== null) acc.sample.offer(numeric);
  }
}

function finishColumn(acc: ColumnAccumulator, rowCount: number): ColumnStatistics {
  const ndv = Math.max(0, Math.min(acc.distinct.estimate(), acc.nonNullCount));
  const nullFraction = rowCount > 0 ? acc.nullCount / rowCount : 0;
  const avgWidth = acc.nonNullCount > 0 ? Math.ceil(acc.totalWidth / acc.nonNullCount) : 8;
  const avgLength = acc.stringCount > 0 ? acc.totalLength / acc.stringCount : null;

  const histogram = acc.numeric && acc.sample.items.length > 0
    ? buildEquiDepthHistogram(acc.sample.items)
    : null;

  const mcv = buildMcv(acc.frequent, acc.nonNullCount);

  return new ColumnStatistics({
    ndv,
    min: acc.min,
    max: acc.max,
    nullFraction,
    histogram,
    mcv,
    avgWidth,
    avgLength,
  });
}

export function buildEquiDepthHistogram(sampledValues: number[]): EquiDepthHistogram {
  const sorted = [...sampledValues].sort((a, b) => a - b);

  const numBuckets = Math.min(Config.statsHistogramBuckets, Math.max(1, Math.floor(sorted.length / 4)));
  const boundaries: ColumnValue[] = [];
  const step = Math.max(1, Math.floor(sorted.length / numBuckets));

  for (let i = 1; i <= numBuckets; i++) {
    boundaries.push(sorted[Math.min(i * step - 1, sorted.length - 1)]);
  }

  const bucketCounts: number[] = new Array(numBuckets).fill(0);
  const bucketDistincts: number[] = new Array(numBuckets).fill(0);
  const bucketOf = (position: number): number => Math.min(Math.floor(position / step), numBuckets - 1);

  for (let i = 0; i < sorted.length; i++) {
    const bucket = bucketOf(i);
    bucketCounts[bucket]++;
    if (i === 0 || bucketOf(i - 1) !== bucket || sorted[i] !== sorted[i - 1]) {
      bucketDistincts[bucket]++;
    }
  }

  return new EquiDepthHistogram(boundaries, { lowerBound: sorted[0], bucketCounts, bucketDistincts });
}

function buildMcv(frequent: SpaceSavingCounter, nonNullCount: number): Mcv | null {
  if (nonNullCount === 0) return null;

  const top = frequent.top(Config.statsMcvCount);
  if (top.length === 0) return null;

  return {
    values: top.map(item => item.value),
    frequencies: top.map(item => item.count / nonNullCount),
  };
}

export class StatisticsCollector {
  static async collect(table: TableStatsSource): Promise<TableStatistics> {
    const schema = table.getSchema();
    const accumulators = schema.map((column, position) => {
      const index = table.getColumnIndex(column.name);
      return createAccumulator(column, index >= 0 ? index : position);
    });

    const correlationColumns = schema
      .map((column, i) => ({ column, acc: accumulators[i] }))
      .filter(entry => CORRELATION_TYPES.has(entry.column.dataType))
      .map(entry => entry.acc);

    const rowSample = new ReservoirSample<number[]>(Config.statsSampleRows, deterministicRandom(0));
    let rowCount = 0;

    for await (const chunk of table.scan()) {
      for (let row = 0; row < chunk.size; row++) {
        rowCount++;
        for (const acc of accumulators) {
          observe(acc, chunk.getValue(row, acc.index));
        }
        if (correlationColumns.length >= 2) {
          rowSample.offer(correlationColumns.map(acc => toNumericValue(chunk.getValue(row, acc.index)) ?? Number.NaN));
        }
      }
    }

    const columnStats = new Map<string, ColumnStatistics>();
    for (const acc of accumulators) {
      columnStats.set(acc.name, finishColumn(acc, rowCount));
    }

    const correlations = computeCorrelations(correlationColumns.map(acc => acc.name), rowSample.items);
    return new TableStatistics(rowCount, columnStats, correlations);
  }
}

function computeCorrelations(columnNames: string[], sampledRows: number[][]): Map<string, number> {
  const correlations = new Map<string, number>();
  if (columnNames.length < 2 || sampledRows.length < 2) return correlations;

  const complete = sampledRows.filter(row => row.every(value => Number.isFinite(value)));
  if (complete.length < 2) return correlations;

  for (let i = 0; i < columnNames.length; i++) {
    for (let j = i + 1; j < columnNames.length; j++) {
      const correlation = pearsonCorrelation(complete, i, j);
      if (Math.abs(correlation) >= Config.statsCorrelationThreshold) {
        const [a, b] = columnNames[i] < columnNames[j]
          ? [columnNames[i], columnNames[j]]
          : [columnNames[j], columnNames[i]];
        correlations.set(`${a}:${b}`, correlation);
      }
    }
  }

  return correlations;
}

function pearsonCorrelation(rows: number[][], xIndex: number, yIndex: number): number {
  const n = rows.length;
  let sumX = 0, sumY = 0;
  for (const row of rows) { sumX += row[xIndex]; sumY += row[yIndex]; }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let covariance = 0, varianceX = 0, varianceY = 0;
  for (const row of rows) {
    const dx = row[xIndex] - meanX;
    const dy = row[yIndex] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 0 ? covariance / denominator : 0;
}
