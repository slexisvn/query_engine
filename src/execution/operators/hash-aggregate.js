import { Column } from '../../storage/column.js';
import { DataChunk, DEFAULT_CHUNK_SIZE } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';
import { globalDispatch } from '../../wasm/dispatch.js';

export class HashAggregateOperator {
  constructor(groupByExtractors, groupByTypes, aggregateDefs) {
    this.groupByExtractors = groupByExtractors;
    this.groupByTypes = groupByTypes;
    this.aggregateDefs = aggregateDefs;
    this.hasCachedValues = aggregateDefs.some(def => def.valueKey);
    this.groups = new Map();
    this.groupKeys = [];
  }

  async init() {}

  async consume(chunk) {
    if (this.groupByExtractors.length === 0 && chunk.size > 0) {
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

  async finalize() {
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
    const size = chunk.size;
    const contributions = new Array(this.aggregateDefs.length);

    for (let a = 0; a < this.aggregateDefs.length; a++) {
      const def = this.aggregateDefs[a];
      const resolved = this._resolveWasmAggKernel(def);
      if (!resolved) return false;

      if (resolved.kind === 'COUNT_STAR') {
        contributions[a] = { kind: 'count', n: size };
        continue;
      }

      if (resolved.kind === 'COUNT') {
        if (def._wasmColIndex === undefined || def._wasmColIndex === null) return false;
        const column = chunk.columns[def._wasmColIndex];
        if (!column) return false;
        if (!column.hasNulls) {
          contributions[a] = { kind: 'count', n: size };
        } else {
          const kernel = globalDispatch.lookup('countBits', 'UINT8');
          if (!kernel) return false;
          contributions[a] = { kind: 'count', n: await kernel(column.nullBitmap, size) };
        }
        continue;
      }

      if (def._wasmColIndex === undefined || def._wasmColIndex === null) return false;
      const column = chunk.columns[def._wasmColIndex];
      if (!column || !column.data || column.hasNulls) return false;
      const colType = column.dataType;
      const matches = (resolved.dataType === 'FLOAT64' && colType === 'FLOAT64')
        || (resolved.dataType === 'INT32' && (colType === 'INT32' || colType === 'DATE'));
      if (!matches) return false;

      const kernel = globalDispatch.lookup(resolved.kernelKey, resolved.dataType);
      if (!kernel) return false;
      const result = await kernel(column.data.subarray(0, size));

      contributions[a] = resolved.kind === 'AVG'
        ? { kind: 'avg', sum: result, n: size }
        : { kind: 'value', result };
    }

    let group = this.groups.get('__ALL__');
    if (!group) {
      group = {
        groupValues: [],
        accumulators: this.aggregateDefs.map(def => def.createAccumulator()),
      };
      this.groups.set('__ALL__', group);
    }

    for (let a = 0; a < contributions.length; a++) {
      const c = contributions[a];
      const acc = group.accumulators[a];
      if (c.kind === 'count') acc.count += c.n;
      else if (c.kind === 'avg') { acc.sum += c.sum; acc.count += c.n; }
      else acc.add(c.result);
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
