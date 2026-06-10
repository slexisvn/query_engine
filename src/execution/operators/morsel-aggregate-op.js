import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { DictionaryColumn } from '../../storage/dictionary-column.js';
import { DataType, isFixedWidth } from '../../storage/data-type.js';

export class MorselAggregateOperator {
  constructor(morselPool, childSchema, outSchema, spec, threshold, fallbackFactory) {
    this.morselPool = morselPool;
    this.childSchema = childSchema;
    this.outSchema = outSchema;
    this.spec = spec;
    this.threshold = threshold;
    this.fallbackFactory = fallbackFactory;
    this.buffered = [];
    this.bufferedRows = 0;
  }

  async consume(chunk) {
    if (chunk.size === 0) return;
    const materialized = chunk.selectionVector ? chunk.flatten() : chunk;
    this.buffered.push(materialized);
    this.bufferedRows += materialized.size;
  }

  async finalize() {
    if (this.bufferedRows < this.threshold) {
      const fallback = this.fallbackFactory();
      for (const chunk of this.buffered) await fallback.consume(chunk);
      return fallback.finalize();
    }
    const rows = await this.morselPool.run(this.buffered, this.childSchema, this.spec);
    if (rows === null) {
      const fallback = this.fallbackFactory();
      for (const chunk of this.buffered) await fallback.consume(chunk);
      return fallback.finalize();
    }
    return [this._buildChunk(rows)];
  }

  _buildChunk(rows) {
    const n = rows.length;
    const cols = this.outSchema.map(s =>
      s.dataType === DataType.VARCHAR ? new DictionaryColumn(Math.max(1, n)) : new Column(s.dataType, Math.max(1, n))
    );
    const isBig = cols.map(c => c.data instanceof BigInt64Array);
    const ng = this.spec.groupCols.length;

    for (let r = 0; r < n; r++) {
      const row = rows[r];
      for (let gi = 0; gi < ng; gi++) this._setVal(cols[gi], isBig[gi], r, row[`__g${gi}`]);
      for (let ai = 0; ai < this.spec.aggs.length; ai++) this._setVal(cols[ng + ai], isBig[ng + ai], r, row[`__a${ai}`]);
    }
    for (const c of cols) c.length = n;
    return new DataChunk(cols, n);
  }

  _setVal(col, big, i, v) {
    if (v === null || v === undefined) { col.set(i, null); return; }
    if (big) { col.set(i, BigInt(typeof v === 'number' ? Math.trunc(v) : v)); return; }
    col.set(i, v);
  }
}

const AGG_FN_MAP = {
  SUM: 'sum', AVG: 'avg', MIN: 'min', MAX: 'max', COUNT: 'count', COUNT_STAR: 'countStar',
};

const MORSEL_NUMERIC = new Set([DataType.INT32, DataType.FLOAT64, DataType.DATE]);

export function buildMorselAggSpec(node, childSchema) {
  const byName = new Map();
  for (const f of childSchema) {
    const key = f.name.toUpperCase();
    if (byName.has(key)) return null;
    byName.set(key, f.dataType);
  }

  const groupCols = [];
  for (let i = 0; i < (node.groupBy || []).length; i++) {
    const g = node.groupBy[i];
    if (!g || !g.columnName) return null;
    const dt = byName.get(g.columnName.toUpperCase());
    if (dt === undefined) return null;
    if (!MORSEL_NUMERIC.has(dt) && dt !== DataType.VARCHAR) return null;
    groupCols.push({ col: g.columnName, out: `__g${i}` });
  }

  const aggs = [];
  for (let i = 0; i < node.aggregates.length; i++) {
    const agg = node.aggregates[i];
    if (agg.distinct) return null;
    const fn = AGG_FN_MAP[agg.name];
    if (!fn) return null;
    if (fn === 'countStar') { aggs.push({ fn, col: null, out: `__a${i}` }); continue; }
    if (agg.args.length !== 1 || !agg.args[0].columnName) return null;
    const dt = byName.get(agg.args[0].columnName.toUpperCase());
    if (dt === undefined || !MORSEL_NUMERIC.has(dt)) return null;
    aggs.push({ fn, col: agg.args[0].columnName, out: `__a${i}` });
  }

  return { filter: [], groupCols, aggs };
}
