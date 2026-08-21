import { Column } from '../../storage/column.js';
import { Config, DEFAULT_CHUNK_SIZE } from '../../config.js';
import { RowMemoryBudget } from '../memory-budget.js';
import { partialGroupsToChunk, chunkToPartialGroups } from './aggregate-state-codec.js';
import type { PartialGroup } from './aggregate-state-codec.js';
import { createKeyedHashTable } from '../hash-table.js';
import type { KeyedHashTable } from '../hash-table.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType, type ColumnValue } from '../../storage/data-type.js';
import { globalDispatch } from '../../wasm/dispatch.js';
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

interface GroupState {
  accumulators: Accumulator[];
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
  groups: KeyedHashTable;
  groupStates: GroupState[];
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
    this.groups = createKeyedHashTable(groupByExtractors.length);
    this.groupStates = [];
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

    this._resetGroups();
    this.memoryBudget.reset();
  }

  _resetGroups(): void {
    this.groups.clear();
    this.groupStates.length = 0;
  }

  _groupStateFor(values: readonly EvalValue[]): GroupState {
    const entry = this.groups.findOrInsert(values);
    let state = this.groupStates[entry];
    if (state === undefined) {
      state = { accumulators: this.aggregateDefs.map((def) => def.createAccumulator()) };
      this.groupStates[entry] = state;
    }
    return state;
  }

  _groupValuesAt(entry: number): ColumnValue[] {
    const values: ColumnValue[] = new Array(this.groups.arity);
    for (let g = 0; g < this.groups.arity; g++) values[g] = this.groups.keyAt(entry, g);
    return values;
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

    if (groupByCount === 0) {
      const group = this._groupStateFor(EMPTY_GROUP_KEY);
      for (let a = 0; a < aggCount; a++) {
        const accumulator = group.accumulators[a];
        const values = aggVals[a];
        for (let i = 0; i < size; i++) accumulator.add(values[i]);
      }
    } else {
      const keyParts: EvalValue[] = new Array(groupByCount);
      for (let i = 0; i < size; i++) {
        for (let g = 0; g < groupByCount; g++) keyParts[g] = groupByVals[g][i];
        const group = this._groupStateFor(keyParts);
        for (let a = 0; a < aggCount; a++) {
          group.accumulators[a].add(aggVals[a][i]);
        }
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
      this._resetGroups();
      for await (const spilled of spillStore.readChunks(this.partitionHandle(partition))) {
        this.absorbPartials(chunkToPartialGroups(spilled));
      }
      for (const chunk of this.emitResidentGroups()) chunks.push(chunk);
    }

    this._resetGroups();
    await spillStore.clearAll();
    return chunks;
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

    const allGroups = this.groupStates;
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
          const value = this.groups.keyAt(start + r, g);
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
    for (let entry = 0; entry < this.groupStates.length; entry++) {
      partitions[this.groups.hashOf(entry) & mask].push({
        groupValues: this._groupValuesAt(entry),
        states: this.groupStates[entry].accumulators.map((acc) => acc.exportState()),
      });
    }
    return partitions;
  }

  absorbPartials(partials: PartialGroup[]): void {
    const aggCount = this.aggregateDefs.length;
    for (const partial of partials) {
      const group = this._groupStateFor(partial.groupValues);
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

    const group = this._groupStateFor(EMPTY_GROUP_KEY);

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

const EMPTY_GROUP_KEY: readonly EvalValue[] = [];

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

export class DistinctAccumulator implements Accumulator {
  values: Set<ColumnValue>;
  makeInner: () => Accumulator;
  constructor(makeInner: () => Accumulator) {
    this.values = new Set();
    this.makeInner = makeInner;
  }
  add(val: EvalValue): void { if (val !== null && val !== undefined) this.values.add(typeof val === 'bigint' ? Number(val) : val as ColumnValue); }
  result(): ColumnValue {
    const inner = this.makeInner();
    for (const val of this.values) inner.add(val);
    return inner.result();
  }
  exportState(): ColumnValue[] { return Array.from(this.values); }
  mergeState(state: ColumnValue[]): void { for (const val of state) this.values.add(val); }
}

const ACCUMULATORS: ReadonlyMap<string, () => Accumulator> = new Map<string, () => Accumulator>([
  ['SUM', () => new SumAccumulator()],
  ['COUNT', () => new CountAccumulator()],
  ['COUNT_STAR', () => new CountStarAccumulator()],
  ['AVG', () => new AvgAccumulator()],
  ['AVG_PARTIAL', () => new AvgAccumulator()],
  ['AVG_FINAL', () => new AvgFinalAccumulator()],
  ['MIN', () => new MinAccumulator()],
  ['MAX', () => new MaxAccumulator()],
]);

const DISTINCT_SENSITIVE_AGGREGATES: ReadonlySet<string> = new Set(['COUNT', 'SUM', 'AVG']);

export function getAccumulatorFactory(name: string, distinct: boolean = false): () => Accumulator {
  const upper = name.toUpperCase();
  const factory = ACCUMULATORS.get(upper);
  if (!factory) throw new Error(`Unknown aggregate: ${name}`);
  if (!distinct || !DISTINCT_SENSITIVE_AGGREGATES.has(upper)) return factory;
  return () => new DistinctAccumulator(factory);
}
