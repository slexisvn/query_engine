import { Column } from '../../storage/column.js';
import { DataChunk, DEFAULT_CHUNK_SIZE } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';
import { globalDispatch } from '../../wasm/dispatch.js';
import { isVectorizableExpr, evalVectorized } from '../wasm-expr-eval.js';
import { Config } from '../../config.js';

export class HashAggregateOperator {
  constructor(groupByExtractors, groupByTypes, aggregateDefs, parallelDispatch) {
    this.groupByExtractors = groupByExtractors;
    this.groupByTypes = groupByTypes;
    this.aggregateDefs = aggregateDefs;
    this.hasCachedValues = aggregateDefs.some(def => def.valueKey);
    this.groups = new Map();
    this.groupKeys = [];
    this.parallelDispatch = parallelDispatch || null;
    this._parallelPlan = undefined;
    this._columnChunks = null;
    this._bufferedCount = 0;
  }

  async init() {}

  async consume(chunk) {
    if (this.groupByExtractors.length === 0 && chunk.size > 0) {
      if (this.parallelDispatch && this._parallelPlan !== null) {
        if (this._parallelPlan === undefined) {
          this._parallelPlan = this._buildParallelPlan();
        }
        if (this._parallelPlan) {
          this._bufferChunk(chunk);
          return;
        }
      }

      if (globalDispatch && globalDispatch.kernels.size > 0) {
        const wasmHandled = await this._tryWasmUngrouped(chunk);
        if (wasmHandled) return;
      }
    }

    const size = chunk.size;
    const hasSv = !!chunk.selectionVector;
    const sv = chunk.selectionVector;
    const groupByCount = this.groupByExtractors.length;
    const aggCount = this.aggregateDefs.length;

    const groupByVals = new Array(groupByCount);
    for (let g = 0; g < groupByCount; g++) {
      groupByVals[g] = new Array(size);
      const fn = this.groupByExtractors[g];
      for (let i = 0; i < size; i++) {
        const rowIdx = hasSv ? sv[i] : i;
        groupByVals[g][i] = fn(chunk, rowIdx);
      }
    }

    const aggVals = new Array(aggCount);
    const extractedKeys = new Set();
    for (let a = 0; a < aggCount; a++) {
      const def = this.aggregateDefs[a];
      if (this.hasCachedValues && def.valueKey && extractedKeys.has(def.valueKey)) {
        for (let prev = 0; prev < a; prev++) {
          if (this.aggregateDefs[prev].valueKey === def.valueKey) {
            aggVals[a] = aggVals[prev];
            break;
          }
        }
      } else {
        aggVals[a] = new Array(size);
        for (let i = 0; i < size; i++) {
          const rowIdx = hasSv ? sv[i] : i;
          aggVals[a][i] = def.extractValue(chunk, rowIdx);
        }
        if (def.valueKey) extractedKeys.add(def.valueKey);
      }
    }

    for (let i = 0; i < size; i++) {
      let key;
      if (groupByCount === 0) {
        key = '__ALL__';
      } else if (groupByCount === 1) {
        const v = groupByVals[0][i];
        key = typeof v === 'bigint' ? v.toString() : String(v);
      } else {
        const parts = new Array(groupByCount);
        for (let g = 0; g < groupByCount; g++) {
          const v = groupByVals[g][i];
          parts[g] = typeof v === 'bigint' ? v.toString() : String(v);
        }
        key = parts.join('|');
      }

      let group = this.groups.get(key);
      if (!group) {
        const gv = new Array(groupByCount);
        for (let g = 0; g < groupByCount; g++) gv[g] = groupByVals[g][i];
        group = {
          groupValues: gv,
          accumulators: this.aggregateDefs.map(def => def.createAccumulator()),
        };
        this.groups.set(key, group);
      }

      for (let a = 0; a < aggCount; a++) {
        group.accumulators[a].add(aggVals[a][i]);
      }
    }
  }

  _buildParallelPlan() {
    const entries = [];
    for (const def of this.aggregateDefs) {
      const resolved = this._resolveWasmAggKernel(def);
      if (!resolved) return null;

      if (resolved.kind === 'COUNT_STAR') {
        entries.push({ kind: 'COUNT_STAR' });
        continue;
      }

      if (resolved.kind === 'COUNT') {
        if (def._wasmColIndex === undefined || def._wasmColIndex === null) return null;
        entries.push({ kind: 'COUNT', colIndex: def._wasmColIndex });
        continue;
      }

      const colIndex = def._wasmColIndex;
      if (colIndex === undefined || colIndex === null) return null;

      entries.push({
        kind: resolved.kind,
        aggType: resolved.kind.toLowerCase(),
        dataType: resolved.dataType,
        colIndex,
      });
    }
    return entries;
  }

  _bufferChunk(chunk) {
    if (!this._columnChunks) {
      this._columnChunks = this._parallelPlan.map(() => []);
    }

    for (let a = 0; a < this._parallelPlan.length; a++) {
      const p = this._parallelPlan[a];
      if (p.kind === 'COUNT_STAR' || p.kind === 'COUNT') continue;

      const column = chunk.columns[p.colIndex];
      if (column?.data) {
        this._columnChunks[a].push(column.data.subarray(0, chunk.size));
      }
    }
    this._bufferedCount += chunk.size;
  }

  async finalize() {
    if (this._parallelPlan && this._bufferedCount > 0) {
      const result = await this._finalizeParallel();
      if (result) return result;
    }

    const groupCount = this.groups.size;
    if (groupCount === 0) {
      if (this.groupByExtractors.length === 0) {
        const cols = this.aggregateDefs.map(def => {
          const col = new Column(def.resultType, 1);
          const acc = def.createAccumulator();
          col.set(0, acc.result());
          col.length = 1;
          return col;
        });
        return [new DataChunk(cols, 1)];
      }
      return [];
    }

    const groupByCount = this.groupByExtractors.length;
    const aggCount = this.aggregateDefs.length;
    const totalCols = groupByCount + aggCount;
    const chunks = [];

    const allGroups = Array.from(this.groups.values());
    for (let start = 0; start < allGroups.length; start += DEFAULT_CHUNK_SIZE) {
      const end = Math.min(start + DEFAULT_CHUNK_SIZE, allGroups.length);
      const batchSize = end - start;

      const columns = new Array(totalCols);
      for (let g = 0; g < groupByCount; g++) {
        columns[g] = new Column(this.groupByTypes[g] || DataType.VARCHAR, batchSize);
      }
      for (let a = 0; a < aggCount; a++) {
        columns[groupByCount + a] = new Column(this.aggregateDefs[a].resultType, batchSize);
      }

      for (let r = 0; r < batchSize; r++) {
        const group = allGroups[start + r];
        for (let g = 0; g < groupByCount; g++) {
          const val = group.groupValues[g];
          columns[g].set(r, typeof val === 'bigint' ? Number(val) : val);
        }
        for (let a = 0; a < aggCount; a++) {
          columns[groupByCount + a].set(r, group.accumulators[a].result());
        }
      }

      for (const col of columns) col.length = batchSize;
      chunks.push(new DataChunk(columns, batchSize));
    }

    return chunks;
  }

  async _finalizeParallel() {
    if (this._bufferedCount < Config.parallelThreshold) return null;

    const results = new Array(this._parallelPlan.length);

    for (let a = 0; a < this._parallelPlan.length; a++) {
      const p = this._parallelPlan[a];

      if (p.kind === 'COUNT_STAR' || p.kind === 'COUNT') {
        results[a] = this._bufferedCount;
        continue;
      }

      const chunks = this._columnChunks[a];
      if (!chunks || chunks.length === 0) return null;

      const Ctor = p.dataType === 'FLOAT64' ? Float64Array : Int32Array;
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const concatenated = new Ctor(totalLen);
      let offset = 0;
      for (const c of chunks) {
        concatenated.set(c, offset);
        offset += c.length;
      }

      if (p.kind === 'AVG') {
        const aggResult = await this.parallelDispatch.aggregateParallel(
          concatenated, totalLen, 'sum', p.dataType
        );
        if (!aggResult) return null;
        results[a] = aggResult.result / totalLen;
      } else {
        const aggResult = await this.parallelDispatch.aggregateParallel(
          concatenated, totalLen, p.aggType, p.dataType
        );
        if (!aggResult) return null;
        results[a] = aggResult.result;
      }
    }

    const cols = this.aggregateDefs.map((def, i) => {
      const col = new Column(def.resultType, 1);
      col.set(0, results[i]);
      col.length = 1;
      return col;
    });
    return [new DataChunk(cols, 1)];
  }

  _resolveWasmAggKernel(def) {
    const name = def.name?.toUpperCase();
    if (!name) return null;

    if (name === 'SUM' && def.resultType === 'FLOAT64') {
      if (globalDispatch.has('sumF64', 'FLOAT64')) return { kernelKey: 'sumF64', dataType: 'FLOAT64', kind: 'SUM' };
      if (globalDispatch.has('sumI32', 'INT32')) return { kernelKey: 'sumI32', dataType: 'INT32', kind: 'SUM' };
    }
    if (name === 'MIN') {
      if (def.resultType === 'FLOAT64' && globalDispatch.has('minF64', 'FLOAT64')) return { kernelKey: 'minF64', dataType: 'FLOAT64', kind: 'MIN' };
      if (def.resultType === 'INT32' && globalDispatch.has('minI32', 'INT32')) return { kernelKey: 'minI32', dataType: 'INT32', kind: 'MIN' };
    }
    if (name === 'MAX') {
      if (def.resultType === 'FLOAT64' && globalDispatch.has('maxF64', 'FLOAT64')) return { kernelKey: 'maxF64', dataType: 'FLOAT64', kind: 'MAX' };
      if (def.resultType === 'INT32' && globalDispatch.has('maxI32', 'INT32')) return { kernelKey: 'maxI32', dataType: 'INT32', kind: 'MAX' };
    }
    if (name === 'COUNT') {
      return { kernelKey: 'countBits', dataType: 'UINT8', kind: 'COUNT' };
    }
    if (name === 'COUNT_STAR') {
      return { kernelKey: null, dataType: null, kind: 'COUNT_STAR' };
    }
    if (name === 'AVG' && def.resultType === 'FLOAT64') {
      if (globalDispatch.has('sumF64', 'FLOAT64')) return { kernelKey: 'sumF64', dataType: 'FLOAT64', kind: 'AVG' };
    }
    return null;
  }

  async _tryWasmUngrouped(chunk) {
    const key = '__ALL__';
    let group = this.groups.get(key);
    if (!group) {
      group = {
        groupValues: [],
        accumulators: this.aggregateDefs.map(def => def.createAccumulator()),
      };
      this.groups.set(key, group);
    }

    for (let a = 0; a < this.aggregateDefs.length; a++) {
      const def = this.aggregateDefs[a];
      const resolved = this._resolveWasmAggKernel(def);
      if (!resolved) return false;

      const acc = group.accumulators[a];

      if (resolved.kind === 'COUNT_STAR') {
        acc.count += chunk.size;
        continue;
      }

      if (resolved.kind === 'COUNT') {
        if (!def._wasmColIndex && def._wasmColIndex !== 0) return false;
        const column = chunk.columns[def._wasmColIndex];
        if (!column) return false;
        if (!column.hasNulls) {
          acc.count += chunk.size;
        } else {
          const kernel = globalDispatch.lookup('countBits', 'UINT8');
          if (!kernel) return false;
          const nonNullCount = await kernel(column.nullBitmap, chunk.size);
          acc.count += nonNullCount;
        }
        continue;
      }

      if (resolved.kind === 'AVG') {
        let avgData = null;

        if (def._wasmColIndex !== undefined && def._wasmColIndex !== null) {
          const column = chunk.columns[def._wasmColIndex];
          if (column && column.data && column.dataType === 'FLOAT64') {
            avgData = column.data.subarray(0, chunk.size);
          }
        }

        if (!avgData && def._sourceExpr && isVectorizableExpr(def._sourceExpr)) {
          const vectorResult = await evalVectorized(def._sourceExpr, chunk, def._columnMapping, chunk.size);
          if (vectorResult instanceof Float64Array) avgData = vectorResult;
        }

        if (!avgData) return false;

        const kernel = globalDispatch.lookup(resolved.kernelKey, resolved.dataType);
        if (!kernel) return false;
        acc.sum += await kernel(avgData);
        acc.count += chunk.size;
        continue;
      }

      let rawData = null;

      if (def._wasmColIndex !== undefined && def._wasmColIndex !== null) {
        const column = chunk.columns[def._wasmColIndex];
        if (column && column.data) {
          const colType = column.dataType;
          if (resolved.dataType === 'FLOAT64' && colType === 'FLOAT64') {
            rawData = column.data.subarray(0, chunk.size);
          } else if (resolved.dataType === 'INT32' && (colType === 'INT32' || colType === 'DATE')) {
            rawData = column.data.subarray(0, chunk.size);
          }
        }
      }

      if (!rawData && def._sourceExpr && isVectorizableExpr(def._sourceExpr)) {
        const vectorResult = await evalVectorized(def._sourceExpr, chunk, def._columnMapping, chunk.size);
        if (vectorResult instanceof Float64Array) {
          rawData = vectorResult;
        }
      }

      if (!rawData) return false;

      const kernel = globalDispatch.lookup(resolved.kernelKey, resolved.dataType);
      if (!kernel) return false;
      const result = await kernel(rawData);

      acc.add(result);
    }

    return true;
  }
}

export class SumAccumulator {
  constructor() { this.sum = 0; this.hasValue = false; }
  add(val) {
    if (val !== null && val !== undefined) {
      this.sum += typeof val === 'bigint' ? Number(val) : Number(val);
      this.hasValue = true;
    }
  }
  result() { return this.hasValue ? this.sum : null; }
}

export class CountAccumulator {
  constructor() { this.count = 0; }
  add(val) { if (val !== null && val !== undefined) this.count++; }
  result() { return this.count; }
}

export class CountStarAccumulator {
  constructor() { this.count = 0; }
  add() { this.count++; }
  result() { return this.count; }
}

export class AvgAccumulator {
  constructor() { this.sum = 0; this.count = 0; }
  add(val) { if (val !== null && val !== undefined) { this.sum += Number(val); this.count++; } }
  result() { return this.count > 0 ? this.sum / this.count : null; }
}

export class MinAccumulator {
  constructor() { this.min = null; }
  add(val) { if (val !== null && val !== undefined && (this.min === null || val < this.min)) this.min = val; }
  result() { return this.min; }
}

export class MaxAccumulator {
  constructor() { this.max = null; }
  add(val) { if (val !== null && val !== undefined && (this.max === null || val > this.max)) this.max = val; }
  result() { return this.max; }
}

export class CountDistinctAccumulator {
  constructor() { this.values = new Set(); }
  add(val) { if (val !== null && val !== undefined) this.values.add(typeof val === 'bigint' ? Number(val) : val); }
  result() { return this.values.size; }
}

export function getAccumulatorFactory(name, distinct = false) {
  if (distinct && (name.toUpperCase() === 'COUNT')) {
    return () => new CountDistinctAccumulator();
  }
  switch (name.toUpperCase()) {
    case 'SUM': return () => new SumAccumulator();
    case 'COUNT': return () => new CountAccumulator();
    case 'COUNT_STAR': return () => new CountStarAccumulator();
    case 'AVG': return () => new AvgAccumulator();
    case 'AVG_PARTIAL': return () => new AvgAccumulator();
    case 'AVG_FINAL': return () => new AvgAccumulator();
    case 'MIN': return () => new MinAccumulator();
    case 'MAX': return () => new MaxAccumulator();
    default: throw new Error(`Unknown aggregate: ${name}`);
  }
}
