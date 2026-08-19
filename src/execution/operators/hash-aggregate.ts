import { Column } from '../../storage/column.js';
import { Config, DEFAULT_CHUNK_SIZE } from '../../config.js';
import { RowMemoryBudget } from '../memory-budget.js';
import { partialGroupsToChunk, chunkToPartialGroups } from './aggregate-state-codec.js';
import { encodeCompositeKey } from '../composite-key.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType, type ColumnValue } from '../../storage/data-type.js';
import { globalDispatch } from '../../wasm/dispatch.js';
import { hashValue } from '../../utils/hash.js';
import { resolveWasmAggKernel, type ScalarReduceKernel, type BitmapCountKernel } from './agg-wasm.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import type { CompiledExpr, ColumnMapping, EvalValue } from '../execution-types.js';
import { KernelOperand } from '../../wasm/wasm-types.js';

type AvgState = { sum: number; count: number };
type AccumulatorState = ColumnValue | AvgState | ColumnValue[];

interface Accumulator {
  add(val: EvalValue): void;
  result(): ColumnValue;
  exportState(): AccumulatorState;
  mergeState(state: AccumulatorState): void;
}

interface NumericAccumulator extends Accumulator {
  sum: number;
  count: number;
}

interface AggregateDef {
  name: string;
  valueKey: string | null;
  resultType: DataType;
  createAccumulator: () => Accumulator;
  extractValue: CompiledExpr;
  _wasmColIndex?: number;
  _sourceExpr: BoundExpr | null;
  _columnMapping: ColumnMapping;
}

type GroupKey = string | number | bigint | boolean | null;

interface GroupState {
  groupValues: ColumnValue[];
  accumulators: Accumulator[];
}

interface PartialGroup {
  key: GroupKey;
  groupValues: ColumnValue[];
  states: AccumulatorState[];
}

interface CountContribution { kind: 'count'; n: number; }
interface AvgContribution { kind: 'avg'; sum: number; n: number; }
interface ValueContribution { kind: 'value'; result: ColumnValue; }
type Contribution = CountContribution | AvgContribution | ValueContribution;

export class HashAggregateOperator {
  groupByExtractors: CompiledExpr[];
  groupByTypes: DataType[];
  aggregateDefs: AggregateDef[];
  hasCachedValues: boolean;
  groups: Map<GroupKey, GroupState>;
  spillStore: ChunkSpillStore | null;
  spillPartitionCount: number;
  memoryBudget: RowMemoryBudget;
  spilledPartitions: Set<number>;

  constructor(
    groupByExtractors: CompiledExpr[],
    groupByTypes: DataType[],
    aggregateDefs: AggregateDef[],
    spillStore: ChunkSpillStore | null = null,
  ) {
    this.groupByExtractors = groupByExtractors;
    this.groupByTypes = groupByTypes;
    this.aggregateDefs = aggregateDefs;
    this.hasCachedValues = aggregateDefs.some((def) => def.valueKey);
    this.groups = new Map();
    this.spillStore = spillStore;
    this.spillPartitionCount = Config.aggSpillPartitions;
    this.memoryBudget = new RowMemoryBudget();
    this.memoryBudget.adoptSchema([...groupByTypes, ...aggregateDefs.map((def) => def.resultType)]);
    this.spilledPartitions = new Set();
  }

  partitionHandle(partition: number): string {
    return `agg_${partition}`;
  }

  async spillResidentGroups(): Promise<void> {
    if (!this.spillStore || this.groups.size === 0) return;

    const partitions = this.exportPartials(this.spillPartitionCount);
    for (let p = 0; p < partitions.length; p++) {
      if (partitions[p].length === 0) continue;
      await this.spillStore.appendChunk(this.partitionHandle(p), partialGroupsToChunk(partitions[p]));
      this.spilledPartitions.add(p);
    }

    this.groups.clear();
    this.memoryBudget.reset();
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
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

    const groupByVals: EvalValue[][] = new Array(groupByCount);
    for (let g = 0; g < groupByCount; g++) {
      groupByVals[g] = new Array(size);
      const fn = this.groupByExtractors[g];
      for (let i = 0; i < size; i++) {
        const rowIdx = hasSv ? sv![i] : i;
        groupByVals[g][i] = fn(chunk, rowIdx);
      }
    }

    const aggVals: EvalValue[][] = new Array(aggCount);
    const extractedKeys = new Set<string>();
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
          const rowIdx = hasSv ? sv![i] : i;
          aggVals[a][i] = def.extractValue(chunk, rowIdx);
        }
        if (def.valueKey) extractedKeys.add(def.valueKey);
      }
    }

    const keyParts: EvalValue[] = new Array(groupByCount);
    for (let i = 0; i < size; i++) {
      let key: GroupKey;
      if (groupByCount === 0) {
        key = GLOBAL_GROUP_KEY;
      } else if (groupByCount === 1) {
        key = groupByVals[0][i] as GroupKey;
      } else {
        for (let g = 0; g < groupByCount; g++) keyParts[g] = groupByVals[g][i];
        key = encodeCompositeKey(keyParts);
      }

      let group = this.groups.get(key);
      if (!group) {
        const gv: ColumnValue[] = new Array(groupByCount);
        for (let g = 0; g < groupByCount; g++) gv[g] = groupByVals[g][i] as ColumnValue;
        group = {
          groupValues: gv,
          accumulators: this.aggregateDefs.map((def) => def.createAccumulator()),
        };
        this.groups.set(key, group);
      }

      for (let a = 0; a < aggCount; a++) {
        group.accumulators[a].add(aggVals[a][i]);
      }
    }

    this.memoryBudget.reset();
    this.memoryBudget.admit(this.groups.size);
    if (this.spillStore && this.memoryBudget.exceeded) {
      await this.spillResidentGroups();
    }
  }

  async finalize(): Promise<DataChunk[]> {
    if (this.spillStore && this.spilledPartitions.size > 0) {
      return this.finalizeSpilled(this.spillStore);
    }
    return this.emitResidentGroups();
  }

  async finalizeSpilled(spillStore: ChunkSpillStore): Promise<DataChunk[]> {
    await this.spillResidentGroups();

    const chunks: DataChunk[] = [];
    const ordered = [...this.spilledPartitions].sort((a, b) => a - b);

    for (const partition of ordered) {
      this.groups.clear();
      for await (const spilled of spillStore.readChunks(this.partitionHandle(partition))) {
        this.absorbPartials(chunkToPartialGroups(spilled).map((record) => ({
          key: this.groupKeyOf(record.groupValues),
          groupValues: record.groupValues,
          states: record.states,
        })));
      }
      for (const chunk of this.emitResidentGroups()) chunks.push(chunk);
    }

    this.groups.clear();
    await spillStore.clearAll();
    return chunks;
  }

  groupKeyOf(groupValues: ColumnValue[]): GroupKey {
    if (groupValues.length === 0) return GLOBAL_GROUP_KEY;
    if (groupValues.length === 1) return groupValues[0] as GroupKey;

    return encodeCompositeKey(groupValues);
  }

  emitResidentGroups(): DataChunk[] {
    const groupCount = this.groups.size;
    if (groupCount === 0) {
      if (this.groupByExtractors.length === 0) {
        const cols = this.aggregateDefs.map((def) => {
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
    const chunks: DataChunk[] = [];

    const allGroups: GroupState[] = Array.from(this.groups.values());
    for (let start = 0; start < allGroups.length; start += DEFAULT_CHUNK_SIZE) {
      const end = Math.min(start + DEFAULT_CHUNK_SIZE, allGroups.length);
      const batchSize = end - start;

      const columns: Column[] = new Array(totalCols);
      for (let g = 0; g < groupByCount; g++) {
        columns[g] = new Column(this.groupByTypes[g] || DataType.VARCHAR, batchSize);
      }
      for (let a = 0; a < aggCount; a++) {
        columns[groupByCount + a] = new Column(this.aggregateDefs[a].resultType, batchSize);
      }

      for (let r = 0; r < batchSize; r++) {
        const group = allGroups[start + r];
        for (let g = 0; g < groupByCount; g++) {
          const value = group.groupValues[g];
          columns[g].set(r, typeof value === 'bigint' ? Number(value) : value);
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

  exportPartials(partitionCount: number): PartialGroup[][] {
    const mask = partitionCount - 1;
    const partitions: PartialGroup[][] = Array.from({ length: partitionCount }, () => []);
    for (const [key, group] of this.groups) {
      partitions[hashGroupKey(key) & mask].push({
        key,
        groupValues: group.groupValues,
        states: group.accumulators.map((acc) => acc.exportState()),
      });
    }
    return partitions;
  }

  absorbPartials(partials: PartialGroup[]): void {
    const aggCount = this.aggregateDefs.length;
    for (const partial of partials) {
      let group = this.groups.get(partial.key);
      if (!group) {
        group = {
          groupValues: partial.groupValues,
          accumulators: this.aggregateDefs.map((def) => def.createAccumulator()),
        };
        this.groups.set(partial.key, group);
      }
      for (let a = 0; a < aggCount; a++) {
        group.accumulators[a].mergeState(partial.states[a]);
      }
    }
  }

  async _tryWasmUngrouped(chunk: DataChunk): Promise<boolean> {
    const size = chunk.size;
    const contributions: Contribution[] = new Array(this.aggregateDefs.length);

    for (let a = 0; a < this.aggregateDefs.length; a++) {
      const def = this.aggregateDefs[a];
      const resolved = resolveWasmAggKernel(def, globalDispatch);
      if (!resolved) return false;

      if (resolved.kind === 'COUNT_STAR') {
        contributions[a] = { kind: 'count', n: size };
        continue;
      }

      if (resolved.kind === 'COUNT') {
        if (def._wasmColIndex === undefined || def._wasmColIndex === null) return false;
        const column = chunk.columns[def._wasmColIndex] as Column;
        if (!column) return false;
        if (!column.hasNulls) {
          contributions[a] = { kind: 'count', n: size };
        } else {
          const kernel = globalDispatch.lookup('countBits', KernelOperand.BITMAP) as BitmapCountKernel | null;
          if (!kernel) return false;
          contributions[a] = { kind: 'count', n: await kernel(column.nullBitmap, size) };
        }
        continue;
      }

      if (def._wasmColIndex === undefined || def._wasmColIndex === null) return false;
      const column = chunk.columns[def._wasmColIndex] as Column;
      if (!column || !column.data || column.hasNulls) return false;
      const colType = column.dataType;
      const matches = (resolved.operand === 'FLOAT64' && colType === 'FLOAT64')
        || (resolved.operand === 'INT32' && (colType === 'INT32' || colType === 'DATE'));
      if (!matches) return false;

      const kernel = globalDispatch.lookup(resolved.kernelKey!, resolved.operand!) as ScalarReduceKernel | null;
      if (!kernel) return false;
      const result = await kernel((column.data as Float64Array).subarray(0, size));

      contributions[a] = resolved.kind === 'AVG'
        ? { kind: 'avg', sum: result, n: size }
        : { kind: 'value', result };
    }

    let group = this.groups.get(GLOBAL_GROUP_KEY);
    if (!group) {
      group = {
        groupValues: [],
        accumulators: this.aggregateDefs.map((def) => def.createAccumulator()),
      };
      this.groups.set(GLOBAL_GROUP_KEY, group);
    }

    for (let a = 0; a < contributions.length; a++) {
      const c = contributions[a];
      const acc = group.accumulators[a] as NumericAccumulator;
      if (c.kind === 'count') acc.count += c.n;
      else if (c.kind === 'avg') { acc.sum += c.sum; acc.count += c.n; }
      else acc.add(c.result);
    }

    return true;
  }
}

export const GLOBAL_GROUP_KEY = '__ALL__';

export function hashGroupKey(key: GroupKey): number {
  if (key === null || key === undefined) return 0;
  return hashValue(key);
}

export class SumAccumulator implements Accumulator {
  sum: number;
  hasValue: boolean;
  constructor() { this.sum = 0; this.hasValue = false; }
  add(val: EvalValue): void {
    if (val !== null && val !== undefined) {
      this.sum += typeof val === 'bigint' ? Number(val) : Number(val);
      this.hasValue = true;
    }
  }
  result(): ColumnValue { return this.hasValue ? this.sum : null; }
  exportState(): ColumnValue { return this.hasValue ? this.sum : null; }
  mergeState(state: number | null): void {
    if (state !== null && state !== undefined) {
      this.sum += state;
      this.hasValue = true;
    }
  }
}

export class CountAccumulator implements Accumulator {
  count: number;
  constructor() { this.count = 0; }
  add(val: EvalValue): void { if (val !== null && val !== undefined) this.count++; }
  result(): ColumnValue { return this.count; }
  exportState(): ColumnValue { return this.count; }
  mergeState(state: number): void { this.count += state; }
}

export class CountStarAccumulator implements Accumulator {
  count: number;
  constructor() { this.count = 0; }
  add(): void { this.count++; }
  result(): ColumnValue { return this.count; }
  exportState(): ColumnValue { return this.count; }
  mergeState(state: number): void { this.count += state; }
}

export class AvgAccumulator implements Accumulator {
  sum: number;
  count: number;
  constructor() { this.sum = 0; this.count = 0; }
  add(val: EvalValue): void { if (val !== null && val !== undefined) { this.sum += Number(val); this.count++; } }
  result(): ColumnValue { return this.count > 0 ? this.sum / this.count : null; }
  exportState(): AvgState { return { sum: this.sum, count: this.count }; }
  mergeState(state: AvgState): void { this.sum += state.sum; this.count += state.count; }
}

export class AvgFinalAccumulator implements Accumulator {
  sum: number;
  count: number;
  constructor() { this.sum = 0; this.count = 0; }
  add(pair: EvalValue | ColumnValue[]): void {
    if (!pair) return;
    const arr = pair as ColumnValue[];
    const s = arr[0], c = arr[1];
    if (s !== null && s !== undefined && c !== null && c !== undefined) {
      this.sum += Number(s);
      this.count += Number(c);
    }
  }
  result(): ColumnValue { return this.count > 0 ? this.sum / this.count : null; }
  exportState(): AvgState { return { sum: this.sum, count: this.count }; }
  mergeState(state: AvgState): void { this.sum += state.sum; this.count += state.count; }
}

export class MinAccumulator implements Accumulator {
  min: ColumnValue;
  constructor() { this.min = null; }
  add(val: EvalValue): void { if (val !== null && val !== undefined && (this.min === null || (val as number) < (this.min as number))) this.min = val as ColumnValue; }
  result(): ColumnValue { return this.min; }
  exportState(): ColumnValue { return this.min; }
  mergeState(state: ColumnValue): void {
    if (state !== null && state !== undefined && (this.min === null || (state as number) < (this.min as number))) this.min = state;
  }
}

export class MaxAccumulator implements Accumulator {
  max: ColumnValue;
  constructor() { this.max = null; }
  add(val: EvalValue): void { if (val !== null && val !== undefined && (this.max === null || (val as number) > (this.max as number))) this.max = val as ColumnValue; }
  result(): ColumnValue { return this.max; }
  exportState(): ColumnValue { return this.max; }
  mergeState(state: ColumnValue): void {
    if (state !== null && state !== undefined && (this.max === null || (state as number) > (this.max as number))) this.max = state;
  }
}

export class CountDistinctAccumulator implements Accumulator {
  values: Set<ColumnValue>;
  constructor() { this.values = new Set(); }
  add(val: EvalValue): void { if (val !== null && val !== undefined) this.values.add(typeof val === 'bigint' ? Number(val) : val as ColumnValue); }
  result(): ColumnValue { return this.values.size; }
  exportState(): ColumnValue[] { return Array.from(this.values); }
  mergeState(state: ColumnValue[]): void { for (const val of state) this.values.add(val); }
}

export function getAccumulatorFactory(name: string, distinct: boolean = false): () => Accumulator {
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
