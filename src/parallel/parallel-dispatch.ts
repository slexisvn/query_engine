import { Config } from '../config.js';
import type { AnyTypedArray, ColumnValue, DataType } from '../storage/data-type.js';
import type { WasmVecData } from '../wasm/wasm-types.js';
import type {
  FilterOperation,
  CompoundCombineOp,
  ScalarAggType,
  WasmDataType,
  ProjectOp,
  FilterDescriptor,
  PipelineStage,
  FilterTask,
  AggregateTask,
  CompoundFilterTask,
  PipelineTask,
  ProjectTask,
  SelectionVectorResult,
  ScalarAggregateResult,
  ProjectResult,
  ScalarAggregatePartial,
  TaskOfType,
  WorkerResultForTask,
} from './worker-messages.js';
import { WorkerTaskType } from './worker-messages.js';

const PARALLELIZABLE_TYPES = new Set<string>(['INT32', 'FLOAT64', 'DATE']);

const FILTER_OPS = new Set<string>([
  'filterEq', 'filterLt', 'filterGt', 'filterLe', 'filterGe', 'filterBetween',
]);

const AGG_OPS = new Set<string>(['sum', 'min', 'max']);

const PROJECT_OPS = new Set<string>([
  'scalarAddF64', 'scalarSubF64', 'scalarMulF64', 'scalarDivF64',
  'scalarSubRevF64', 'scalarDivRevF64',
  'vecAddF64', 'vecSubF64', 'vecMulF64', 'vecDivF64',
  'negF64', 'widenI32ToF64',
]);

const BYTE_WIDTH: Record<string, number> = { INT32: 4, FLOAT64: 8, DATE: 4 };

type WasmKernel = (
  data: WasmVecData | number,
  arg1?: WasmVecData | number,
  arg2?: WasmVecData | number,
) => Promise<Uint32Array | number> | WasmVecData | Promise<WasmVecData>;

interface RegionAllocatorLike {
  memory: WebAssembly.Memory;
  resetStaging(): void;
  allocStaging(bytes: number): number;
}

interface GlobalDispatchLike {
  lookup(operation: string, dataType: string): WasmKernel | null;
}

interface WorkerPoolLike {
  activeWorkerCount(): number;
  execute<T extends WorkerTaskType>(tasks: TaskOfType<T>[]): Promise<WorkerResultForTask[T][]>;
}

interface FilterParams {
  value?: ColumnValue;
  low?: ColumnValue;
  high?: ColumnValue;
}

interface ProjectParams {
  scalar?: number;
  dataB?: AnyTypedArray;
}

interface Morsel {
  start: number;
  length: number;
}

interface PipelineAggregatesPartialResult {
  aggregates?: ScalarAggregatePartial[];
}

interface MergedPipelineAggregates {
  aggregates: Record<string, ScalarAggregateResult | null>;
}

interface FilterFallbackParams {
  value?: ColumnValue;
  low?: ColumnValue;
  high?: ColumnValue;
}

export class ParallelDispatch {
  workerPool: WorkerPoolLike | null;
  regionAllocator: RegionAllocatorLike;
  globalDispatch: GlobalDispatchLike;

  constructor(
    workerPool: WorkerPoolLike | null,
    regionAllocator: RegionAllocatorLike,
    globalDispatch: GlobalDispatchLike,
  ) {
    this.workerPool = workerPool;
    this.regionAllocator = regionAllocator;
    this.globalDispatch = globalDispatch;
  }

  canParallelize(operation: string, dataType: string, count: number): boolean {
    if (!this.workerPool || count < Config.parallelThreshold) return false;
    if (!PARALLELIZABLE_TYPES.has(dataType)) return false;

    if (FILTER_OPS.has(operation)) return true;
    if (AGG_OPS.has(operation)) return true;

    return false;
  }

  async filterParallel(
    data: AnyTypedArray,
    count: number,
    operation: string,
    dataType: DataType,
    params: FilterParams,
  ): Promise<SelectionVectorResult | null> {
    if (!this.canParallelize(operation, dataType, count)) {
      return this._filterFallback(operation, dataType, data, params);
    }

    const bw = BYTE_WIDTH[dataType];
    const dataPtr = this._resolveDataPtr(data, count, bw);

    const workerCount = this.workerPool!.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks: FilterTask[] = morsels.map(morsel => ({
      type: WorkerTaskType.FILTER,
      dataOffset: dataPtr + morsel.start * bw,
      count: morsel.length,
      operation: operation as FilterOperation,
      dataType: dataType as WasmDataType,
      baseIndex: morsel.start,
      ...params,
    } as FilterTask));

    const results = await this.workerPool!.execute(tasks);
    return this._gatherSelectionVectors(results, count);
  }

  async aggregateParallel(
    data: AnyTypedArray,
    count: number,
    aggType: string,
    dataType: DataType,
  ): Promise<ScalarAggregateResult | null> {
    if (!this.canParallelize(aggType, dataType, count)) {
      return this._aggregateFallback(aggType, dataType, data);
    }

    const bw = BYTE_WIDTH[dataType];
    const dataPtr = this._resolveDataPtr(data, count, bw);

    const workerCount = this.workerPool!.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks: AggregateTask[] = morsels.map(morsel => ({
      type: WorkerTaskType.AGGREGATE,
      dataOffset: dataPtr + morsel.start * bw,
      count: morsel.length,
      aggType: aggType as ScalarAggType,
      dataType: dataType as WasmDataType,
    }));

    const results = await this.workerPool!.execute(tasks);
    return this._mergeAggregates(results, aggType);
  }

  async compoundFilterParallel(
    data: AnyTypedArray,
    count: number,
    filters: FilterDescriptor[],
    combineOp: CompoundCombineOp,
    dataType: DataType,
  ): Promise<SelectionVectorResult | null> {
    const validOps = filters.every(f => FILTER_OPS.has(f.operation));
    if (!validOps || !this.canParallelize(filters[0].operation, dataType, count)) {
      return this._compoundFilterFallback(data, count, filters, combineOp, dataType);
    }

    const bw = BYTE_WIDTH[dataType];
    const dataPtr = this._resolveDataPtr(data, count, bw);

    const workerCount = this.workerPool!.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks: CompoundFilterTask[] = morsels.map(morsel => ({
      type: WorkerTaskType.FILTER_COMPOUND,
      dataOffset: dataPtr + morsel.start * bw,
      count: morsel.length,
      filters,
      combineOp,
      dataType: dataType as WasmDataType,
      baseIndex: morsel.start,
    }));

    const results = await this.workerPool!.execute(tasks);
    return this._gatherSelectionVectors(results, count);
  }

  async pipelineParallel(
    data: AnyTypedArray,
    count: number,
    dataType: DataType,
    stages: PipelineStage[],
  ): Promise<SelectionVectorResult | MergedPipelineAggregates> {
    const bw = BYTE_WIDTH[dataType];
    if (!PARALLELIZABLE_TYPES.has(dataType) || !this.workerPool || count < Config.parallelThreshold) {
      return this._pipelineFallback(data, count, dataType, stages);
    }

    const dataPtr = this._resolveDataPtr(data, count, bw);

    const workerCount = this.workerPool.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks: PipelineTask[] = morsels.map(morsel => ({
      type: WorkerTaskType.PIPELINE,
      dataOffset: dataPtr + morsel.start * bw,
      count: morsel.length,
      dataType: dataType as WasmDataType,
      baseIndex: morsel.start,
      stages,
    }));

    const results = await this.workerPool.execute(tasks);
    const hasAggregates = results.some(r => r.aggregates);

    if (hasAggregates) {
      return this._mergePipelineAggregates(results);
    }

    return this._gatherSelectionVectors(results, count);
  }

  async projectParallel(
    data: AnyTypedArray,
    count: number,
    op: string,
    params: ProjectParams = {},
  ): Promise<Float64Array | null> {
    if (!this.workerPool || count < Config.parallelThreshold || !PROJECT_OPS.has(op)) {
      return null;
    }

    const bw = data instanceof Float64Array ? 8 : 4;

    this.regionAllocator.resetStaging();
    const dataPtr = this.regionAllocator.allocStaging(count * bw);
    if (bw === 4) {
      new Int32Array(this.regionAllocator.memory.buffer, dataPtr, count).set(data.subarray(0, count) as ArrayLike<number>);
    } else {
      new Float64Array(this.regionAllocator.memory.buffer, dataPtr, count).set(data.subarray(0, count) as ArrayLike<number>);
    }

    let dataBPtr: number | undefined;
    if (params.dataB) {
      const bwB = params.dataB instanceof Float64Array ? 8 : 4;
      dataBPtr = this.regionAllocator.allocStaging(count * bwB);
      if (bwB === 4) {
        new Int32Array(this.regionAllocator.memory.buffer, dataBPtr, count).set(params.dataB.subarray(0, count) as ArrayLike<number>);
      } else {
        new Float64Array(this.regionAllocator.memory.buffer, dataBPtr, count).set(params.dataB.subarray(0, count) as ArrayLike<number>);
      }
    }

    const workerCount = this.workerPool!.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks: ProjectTask[] = morsels.map(morsel => {
      const task: ProjectTask = {
        type: WorkerTaskType.PROJECT,
        dataOffset: dataPtr + morsel.start * bw,
        count: morsel.length,
        op: op as ProjectOp,
        scalar: params.scalar,
      };
      if (dataBPtr !== undefined) {
        const bwB = params.dataB instanceof Float64Array ? 8 : 4;
        task.dataBOffset = dataBPtr + morsel.start * bwB;
      }
      return task;
    });

    const results = await this.workerPool!.execute(tasks);
    return this._gatherProjectResults(results, count);
  }

  _gatherProjectResults(results: ProjectResult[], totalCount: number): Float64Array {
    const output = new Float64Array(totalCount);
    let writePos = 0;
    for (const r of results) {
      if (r.resultData) {
        output.set(r.resultData, writePos);
      }
      writePos += r.count;
    }
    return output;
  }

  _resolveDataPtr(data: AnyTypedArray, count: number, bw: number): number {
    if (data.buffer === this.regionAllocator.memory.buffer) {
      return data.byteOffset;
    }

    this.regionAllocator.resetStaging();
    const ptr = this.regionAllocator.allocStaging(count * bw);
    const memory = this.regionAllocator.memory;

    if (bw === 4) {
      new Int32Array(memory.buffer, ptr, count).set(data.subarray(0, count) as ArrayLike<number>);
    } else {
      new Float64Array(memory.buffer, ptr, count).set(data.subarray(0, count) as ArrayLike<number>);
    }

    return ptr;
  }

  _splitRange(totalCount: number, workerCount: number): Morsel[] {
    const morselCount = Math.max(workerCount, Math.ceil(totalCount / Config.morselSize));
    const morselSize = Math.ceil(totalCount / morselCount);
    const morsels: Morsel[] = [];

    let offset = 0;
    while (offset < totalCount) {
      const length = Math.min(morselSize, totalCount - offset);
      morsels.push({ start: offset, length });
      offset += length;
    }

    return morsels;
  }

  _gatherSelectionVectors(results: SelectionVectorResult[], totalCount: number): SelectionVectorResult {
    let totalMatches = 0;
    for (const r of results) totalMatches += r.matchCount;

    const merged = new Uint32Array(totalMatches);
    let writePos = 0;

    for (const r of results) {
      if (r.matchCount > 0 && r.selectionVector) {
        merged.set(r.selectionVector, writePos);
        writePos += r.matchCount;
      }
    }

    return { selectionVector: merged, matchCount: totalMatches };
  }

  _mergeAggregates(results: ScalarAggregateResult[], aggType: string): ScalarAggregateResult | null {
    if (results.length === 0) return null;

    if (aggType === 'sum' || aggType === 'count') {
      let total = 0;
      let totalCount = 0;
      for (const r of results) {
        total += r.result;
        totalCount += r.count;
      }
      return { result: total, count: totalCount };
    }

    if (aggType === 'min') {
      let min = results[0].result;
      let totalCount = 0;
      for (const r of results) {
        if (r.result < min) min = r.result;
        totalCount += r.count;
      }
      return { result: min, count: totalCount };
    }

    if (aggType === 'max') {
      let max = results[0].result;
      let totalCount = 0;
      for (const r of results) {
        if (r.result > max) max = r.result;
        totalCount += r.count;
      }
      return { result: max, count: totalCount };
    }

    return null;
  }

  _mergePipelineAggregates(results: PipelineAggregatesPartialResult[]): MergedPipelineAggregates {
    const aggMap = new Map<string, ScalarAggregatePartial[]>();

    for (const r of results) {
      if (!r.aggregates) continue;
      for (const agg of r.aggregates) {
        if (!aggMap.has(agg.aggType)) {
          aggMap.set(agg.aggType, []);
        }
        aggMap.get(agg.aggType)!.push(agg);
      }
    }

    const merged: Record<string, ScalarAggregateResult | null> = {};
    for (const [aggType, partials] of aggMap) {
      merged[aggType] = this._mergeAggregates(partials, aggType);
    }

    return { aggregates: merged };
  }

  async _compoundFilterFallback(
    data: AnyTypedArray,
    count: number,
    filters: FilterDescriptor[],
    combineOp: CompoundCombineOp,
    dataType: DataType,
  ): Promise<SelectionVectorResult> {
    let svs: Uint32Array[] = [];
    for (const f of filters) {
      const result = await this._filterFallback(f.operation, dataType, data, f);
      if (result) svs.push(result.selectionVector);
    }

    if (svs.length === 0) return { selectionVector: new Uint32Array(0), matchCount: 0 };

    let current = svs[0];
    const merge = combineOp === 'or' ? this._unionSorted : this._intersectSorted;

    for (let i = 1; i < svs.length; i++) {
      current = merge(current, svs[i]);
    }

    return { selectionVector: current, matchCount: current.length };
  }

  async _pipelineFallback(
    data: AnyTypedArray,
    count: number,
    dataType: DataType,
    stages: PipelineStage[],
  ): Promise<SelectionVectorResult | MergedPipelineAggregates> {
    let sv: Uint32Array | null = null;
    let aggResults: Record<string, ScalarAggregateResult> = {};

    for (const stage of stages) {
      if (stage.kind === 'filter') {
        const result = await this._filterFallback(stage.operation, dataType, data, stage);
        if (!result) continue;

        if (sv !== null) {
          sv = this._intersectSorted(sv, result.selectionVector);
        } else {
          sv = result.selectionVector;
        }
      } else if (stage.kind === 'aggregate') {
        const opKey = `${stage.aggType}${dataType === 'INT32' ? 'I32' : 'F64'}`;
        const kernel = this.globalDispatch.lookup(opKey, dataType);
        if (!kernel) continue;

        if (sv !== null) {
          const filtered = this._gatherByIndices(data, sv, dataType);
          const result = await kernel(filtered) as number;
          aggResults[stage.aggType] = { result, count: sv.length };
        } else {
          const result = await kernel(data as WasmVecData) as number;
          aggResults[stage.aggType] = { result, count };
        }
      } else if (stage.kind === 'count') {
        aggResults.count = { result: sv !== null ? sv.length : count, count: sv !== null ? sv.length : count };
      }
    }

    if (Object.keys(aggResults).length > 0) {
      return { aggregates: aggResults };
    }

    return { selectionVector: sv || new Uint32Array(0), matchCount: sv ? sv.length : 0 };
  }

  _gatherByIndices(data: AnyTypedArray, indices: Uint32Array, dataType: DataType): Float64Array | Int32Array {
    const Ctor = dataType === 'FLOAT64' ? Float64Array : Int32Array;
    const out = new Ctor(indices.length);
    for (let i = 0; i < indices.length; i++) out[i] = data[indices[i]] as number;
    return out;
  }

  _intersectSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
    const out = new Uint32Array(Math.min(a.length, b.length));
    let i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { out[k++] = a[i]; i++; j++; }
      else if (a[i] < b[j]) i++;
      else j++;
    }
    return out.subarray(0, k);
  }

  _unionSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
    const out = new Uint32Array(a.length + b.length);
    let i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { out[k++] = a[i]; i++; j++; }
      else if (a[i] < b[j]) { out[k++] = a[i]; i++; }
      else { out[k++] = b[j]; j++; }
    }
    while (i < a.length) out[k++] = a[i++];
    while (j < b.length) out[k++] = b[j++];
    return out.subarray(0, k);
  }

  async _filterFallback(
    operation: string,
    dataType: DataType,
    data: AnyTypedArray,
    params: FilterFallbackParams,
  ): Promise<{ selectionVector: Uint32Array; matchCount: number } | null> {
    const kernel = this.globalDispatch.lookup(operation, dataType);
    if (!kernel) return null;

    if (operation === 'filterBetween') {
      const sv = await kernel(data as WasmVecData, params.low as number, params.high as number) as Uint32Array;
      return { selectionVector: sv, matchCount: sv.length };
    }

    const sv = await kernel(data as WasmVecData, params.value as number) as Uint32Array;
    return { selectionVector: sv, matchCount: sv.length };
  }

  async _aggregateFallback(
    aggType: string,
    dataType: DataType,
    data: AnyTypedArray,
  ): Promise<ScalarAggregateResult | null> {
    const opKey = `${aggType}${dataType === 'INT32' ? 'I32' : 'F64'}`;
    const kernel = this.globalDispatch.lookup(opKey, dataType);
    if (!kernel) return null;

    const result = await kernel(data as WasmVecData) as number;
    return { result, count: data.length };
  }
}
