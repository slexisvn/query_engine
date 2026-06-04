
const HISTOGRAM_BUCKETS = 64;
const MCV_COUNT = 10;

export class ColumnStatistics {
  constructor({ ndv = 0, min = null, max = null, nullFraction = 0, histogram = null, mcv = null, avgWidth = 8 } = {}) {
    this.ndv = ndv;
    this.min = min;
    this.max = max;
    this.nullFraction = nullFraction;
    this.histogram = histogram;   
    this.mcv = mcv;               
    this.avgWidth = avgWidth;      
  }
}

export class TableStatistics {
  constructor(rowCount, columnStats = new Map()) {
    this.rowCount = rowCount;
    this.columnStats = columnStats;
  }

  getColumnStats(columnName) {
    return this.columnStats.get(columnName.toUpperCase()) || null;
  }

  setColumnStats(columnName, stats) {
    this.columnStats.set(columnName.toUpperCase(), stats);
  }

  get avgRowWidth() {
    let width = 0;
    for (const cs of this.columnStats.values()) {
      width += cs.avgWidth || 8;
    }
    return width || 64;
  }
}

export class EquiDepthHistogram {
  constructor(boundaries, numRows) {
    this.boundaries = boundaries;  
    this.numBuckets = boundaries.length;
    this.numRows = numRows;
    this.rowsPerBucket = numRows / Math.max(this.numBuckets, 1);
  }

  estimateLessThan(value) {
    if (this.numBuckets === 0) return 0.5;
    const numVal = toNum(value);
    if (numVal === null) return 0.5;

    let lo = 0, hi = this.numBuckets - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (toNum(this.boundaries[mid]) < numVal) lo = mid + 1;
      else hi = mid - 1;
    }

    if (lo >= this.numBuckets) return 1.0;
    if (lo === 0) {
      const bucketMax = toNum(this.boundaries[0]);
      const bucketMin = this.numBuckets > 0 ? toNum(this.boundaries[0]) : bucketMax;
      const frac = bucketMax > 0 ? Math.max(0, numVal) / bucketMax : 0.5;
      return Math.max(0, Math.min(1, frac / this.numBuckets));
    }

    const bucketMin = toNum(this.boundaries[lo - 1]);
    const bucketMax = toNum(this.boundaries[lo]);
    const range = bucketMax - bucketMin;
    const frac = range > 0 ? (numVal - bucketMin) / range : 0.5;
    return Math.max(0, Math.min(1, (lo + Math.max(0, Math.min(1, frac))) / this.numBuckets));
  }

  estimateRange(low, high) {
    const fracHigh = this.estimateLessThan(high + (typeof high === 'number' ? 0.5 : 0));
    const fracLow = this.estimateLessThan(low);
    return Math.max(0.001, fracHigh - fracLow);
  }
}

export class StatisticsCollector {
  static async collect(table) {
    const rowCount = table.rowCount();
    const columnStats = new Map();

    for (const colDef of table.getSchema()) {
      const stats = await StatisticsCollector._collectColumn(table, colDef, rowCount);
      columnStats.set(colDef.name.toUpperCase(), stats);
    }

    return new TableStatistics(rowCount, columnStats);
  }

  static async _collectColumn(table, colDef, totalRows) {
    const values = [];
    const valueCounts = new Map();
    let nullCount = 0;
    let min = null;
    let max = null;
    let totalWidth = 0;

    const colIdx = table.getColumnIndex(colDef.name);
    const isNumeric = ['INT32', 'INT64', 'FLOAT64', 'DECIMAL', 'DATE'].includes(colDef.dataType);

    for await (const chunk of table.scan()) {
      for (let i = 0; i < chunk.size; i++) {
        const val = chunk.getValue(i, colIdx);
        if (val === null || val === undefined) {
          nullCount++;
          continue;
        }

        const normalized = typeof val === 'bigint' ? Number(val) : val;
        values.push(normalized);

        const key = String(normalized);
        valueCounts.set(key, (valueCounts.get(key) || 0) + 1);

        if (min === null || val < min) min = val;
        if (max === null || val > max) max = val;

        if (typeof val === 'string') totalWidth += val.length * 2;
        else if (typeof val === 'bigint') totalWidth += 8;
        else totalWidth += 4;
      }
    }

    const ndv = new Set(values.map(String)).size;
    const nullFraction = totalRows > 0 ? nullCount / totalRows : 0;
    const avgWidth = values.length > 0 ? Math.ceil(totalWidth / values.length) : 8;

    let histogram = null;
    if (isNumeric && values.length > 0) {
      histogram = StatisticsCollector._buildHistogram(values, totalRows);
    }

    let mcv = null;
    if (valueCounts.size > 0) {
      mcv = StatisticsCollector._buildMCV(valueCounts, values.length);
    }

    return new ColumnStatistics({ ndv, min, max, nullFraction, histogram, mcv, avgWidth });
  }

  static _buildHistogram(values, totalRows) {
    const sorted = [...values].sort((a, b) => {
      const na = typeof a === 'bigint' ? Number(a) : a;
      const nb = typeof b === 'bigint' ? Number(b) : b;
      return na - nb;
    });

    const numBuckets = Math.min(HISTOGRAM_BUCKETS, Math.max(1, Math.floor(sorted.length / 4)));
    const boundaries = [];
    const step = Math.max(1, Math.floor(sorted.length / numBuckets));

    for (let i = 1; i <= numBuckets; i++) {
      const idx = Math.min(i * step - 1, sorted.length - 1);
      boundaries.push(sorted[idx]);
    }

    return new EquiDepthHistogram(boundaries, totalRows);
  }

  static _buildMCV(valueCounts, nonNullCount) {
    const entries = [...valueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MCV_COUNT);

    if (entries.length === 0) return null;

    return {
      values: entries.map(e => e[0]),
      frequencies: entries.map(e => e[1] / nonNullCount),
    };
  }
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  return null;
}
