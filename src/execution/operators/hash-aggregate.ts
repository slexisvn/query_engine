import { Column } from '../../storage/column.js';
import { DataChunk, DEFAULT_CHUNK_SIZE } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';
import { globalDispatch } from '../../wasm/dispatch.js';
import { hashValue } from '../../utils/hash.js';

export class HashAggregateOperator {
  groupByExtractors: any;
  groupByTypes: any;
  aggregateDefs: any;
  hasCachedValues: boolean;
  groups: Map<any, any>;
  groupKeys: any[];

  constructor(groupByExtractors: any, groupByTypes: any, aggregateDefs: any) {
    this.groupByExtractors = groupByExtractors;
    this.groupByTypes = groupByTypes;
    this.aggregateDefs = aggregateDefs;
    this.hasCachedValues = aggregateDefs.some((def: any) => def.valueKey);
    this.groups = new Map();
    this.groupKeys = [];
  }

  async init(): Promise<void> {}

  async consume(chunk: any): Promise<any> {
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
      let key: any;
      if (groupByCount === 0) {
        key = GLOBAL_GROUP_KEY;
      } else if (groupByCount === 1) {
        key = groupByVals[0][i];
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
          accumulators: this.aggregateDefs.map((def: any) => def.createAccumulator()),
        };
        this.groups.set(key, group);
      }

      for (let a = 0; a < aggCount; a++) {
        group.accumulators[a].add(aggVals[a][i]);
      }
    }
  }

  async finalize(): Promise<any> {
    const groupCount = this.groups.size;
    if (groupCount === 0) {
      if (this.groupByExtractors.length === 0) {
        const cols = this.aggregateDefs.map((def: any) => {
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

    const allGroups: any[] = Array.from(this.groups.values());
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

  exportPartials(partitionCount: any): any {
    const mask = partitionCount - 1;
    const partitions: any[] = Array.from({ length: partitionCount }, () => []);
    for (const [key, group] of this.groups) {
      partitions[hashGroupKey(key) & mask].push({
        key,
        groupValues: group.groupValues,
        states: group.accumulators.map((acc: any) => acc.exportState()),
      });
    }
    return partitions;
  }

  absorbPartials(partials: any): void {
    const aggCount = this.aggregateDefs.length;
    for (const partial of partials) {
      let group = this.groups.get(partial.key);
      if (!group) {
        group = {
          groupValues: partial.groupValues,
          accumulators: this.aggregateDefs.map((def: any) => def.createAccumulator()),
        };
        this.groups.set(partial.key, group);
      }
      for (let a = 0; a < aggCount; a++) {
        group.accumulators[a].mergeState(partial.states[a]);
      }
    }
  }

  _resolveWasmAggKernel(def: any): any {
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

  async _tryWasmUngrouped(chunk: any): Promise<any> {
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

    let group = this.groups.get(GLOBAL_GROUP_KEY);
    if (!group) {
      group = {
        groupValues: [],
        accumulators: this.aggregateDefs.map((def: any) => def.createAccumulator()),
      };
      this.groups.set(GLOBAL_GROUP_KEY, group);
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

export const GLOBAL_GROUP_KEY = '__ALL__';

export function hashGroupKey(key: any): any {
  if (key === null || key === undefined) return 0;
  return hashValue(key);
}

export class SumAccumulator {
  sum: number;
  hasValue: boolean;
  constructor() { this.sum = 0; this.hasValue = false; }
  add(val: any): void {
    if (val !== null && val !== undefined) {
      this.sum += typeof val === 'bigint' ? Number(val) : Number(val);
      this.hasValue = true;
    }
  }
  result(): any { return this.hasValue ? this.sum : null; }
  exportState(): any { return this.hasValue ? this.sum : null; }
  mergeState(state: any): void {
    if (state !== null && state !== undefined) {
      this.sum += state;
      this.hasValue = true;
    }
  }
}

export class CountAccumulator {
  count: number;
  constructor() { this.count = 0; }
  add(val: any): void { if (val !== null && val !== undefined) this.count++; }
  result(): any { return this.count; }
  exportState(): any { return this.count; }
  mergeState(state: any): void { this.count += state; }
}

export class CountStarAccumulator {
  count: number;
  constructor() { this.count = 0; }
  add(): void { this.count++; }
  result(): any { return this.count; }
  exportState(): any { return this.count; }
  mergeState(state: any): void { this.count += state; }
}

export class AvgAccumulator {
  sum: number;
  count: number;
  constructor() { this.sum = 0; this.count = 0; }
  add(val: any): void { if (val !== null && val !== undefined) { this.sum += Number(val); this.count++; } }
  result(): any { return this.count > 0 ? this.sum / this.count : null; }
  exportState(): any { return { sum: this.sum, count: this.count }; }
  mergeState(state: any): void { this.sum += state.sum; this.count += state.count; }
}

export class AvgFinalAccumulator {
  sum: number;
  count: number;
  constructor() { this.sum = 0; this.count = 0; }
  add(pair: any): void {
    if (!pair) return;
    const s = pair[0], c = pair[1];
    if (s !== null && s !== undefined && c !== null && c !== undefined) {
      this.sum += Number(s);
      this.count += Number(c);
    }
  }
  result(): any { return this.count > 0 ? this.sum / this.count : null; }
  exportState(): any { return { sum: this.sum, count: this.count }; }
  mergeState(state: any): void { this.sum += state.sum; this.count += state.count; }
}

export class MinAccumulator {
  min: any;
  constructor() { this.min = null; }
  add(val: any): void { if (val !== null && val !== undefined && (this.min === null || val < this.min)) this.min = val; }
  result(): any { return this.min; }
  exportState(): any { return this.min; }
  mergeState(state: any): void {
    if (state !== null && state !== undefined && (this.min === null || state < this.min)) this.min = state;
  }
}

export class MaxAccumulator {
  max: any;
  constructor() { this.max = null; }
  add(val: any): void { if (val !== null && val !== undefined && (this.max === null || val > this.max)) this.max = val; }
  result(): any { return this.max; }
  exportState(): any { return this.max; }
  mergeState(state: any): void {
    if (state !== null && state !== undefined && (this.max === null || state > this.max)) this.max = state;
  }
}

export class CountDistinctAccumulator {
  values: Set<any>;
  constructor() { this.values = new Set(); }
  add(val: any): void { if (val !== null && val !== undefined) this.values.add(typeof val === 'bigint' ? Number(val) : val); }
  result(): any { return this.values.size; }
  exportState(): any { return Array.from(this.values); }
  mergeState(state: any): void { for (const val of state) this.values.add(val); }
}

export function getAccumulatorFactory(name: any, distinct: boolean = false): any {
  if (distinct && (name.toUpperCase() === 'COUNT')) {
    return () => new CountDistinctAccumulator();
  }
  switch (name.toUpperCase()) {
    case 'SUM': return () => new SumAccumulator();
    case 'COUNT': return () => new CountAccumulator();
    case 'COUNT_STAR': return () => new CountStarAccumulator();
    case 'AVG': return () => new AvgAccumulator();
    case 'AVG_PARTIAL': return () => new AvgAccumulator();
    case 'AVG_FINAL': return () => new AvgFinalAccumulator();
    case 'MIN': return () => new MinAccumulator();
    case 'MAX': return () => new MaxAccumulator();
    default: throw new Error(`Unknown aggregate: ${name}`);
  }
}
