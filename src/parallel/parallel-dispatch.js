import { Config } from '../config.js';

const PARALLELIZABLE_TYPES = new Set(['INT32', 'FLOAT64', 'DATE']);

const FILTER_OPS = new Set([
  'filterEq', 'filterLt', 'filterGt', 'filterLe', 'filterGe', 'filterBetween',
]);

const AGG_OPS = new Set(['sum', 'min', 'max']);

const PROJECT_OPS = new Set([
  'scalarAddF64', 'scalarSubF64', 'scalarMulF64', 'scalarDivF64',
  'scalarSubRevF64', 'scalarDivRevF64',
  'vecAddF64', 'vecSubF64', 'vecMulF64', 'vecDivF64',
  'negF64', 'widenI32ToF64',
]);

const BYTE_WIDTH = { INT32: 4, FLOAT64: 8, DATE: 4 };

export class ParallelDispatch {
  constructor(workerPool, regionAllocator, globalDispatch) {
    this.workerPool = workerPool;
    this.regionAllocator = regionAllocator;
    this.globalDispatch = globalDispatch;
  }

  canParallelize(operation, dataType, count) {
    if (!this.workerPool || count < Config.parallelThreshold) return false;
    if (!PARALLELIZABLE_TYPES.has(dataType)) return false;

    if (FILTER_OPS.has(operation)) return true;
    if (AGG_OPS.has(operation)) return true;

    return false;
  }

  async filterParallel(data, count, operation, dataType, params) {
    if (!this.canParallelize(operation, dataType, count)) {
      return this._filterFallback(operation, dataType, data, params);
    }

    const bw = BYTE_WIDTH[dataType];
    const dataPtr = this._resolveDataPtr(data, count, bw);

    const workerCount = this.workerPool.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks = morsels.map(morsel => ({
      type: 'filter',
      dataOffset: dataPtr + morsel.start * bw,
      count: morsel.length,
      operation,
      dataType,
      baseIndex: morsel.start,
      ...params,
    }));

    const results = await this.workerPool.execute(tasks);
    return this._gatherSelectionVectors(results, count);
  }

  async aggregateParallel(data, count, aggType, dataType) {
    if (!this.canParallelize(aggType, dataType, count)) {
      return this._aggregateFallback(aggType, dataType, data);
    }

    const bw = BYTE_WIDTH[dataType];
    const dataPtr = this._resolveDataPtr(data, count, bw);

    const workerCount = this.workerPool.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks = morsels.map(morsel => ({
      type: 'aggregate',
      dataOffset: dataPtr + morsel.start * bw,
      count: morsel.length,
      aggType,
      dataType,
    }));

    const results = await this.workerPool.execute(tasks);
    return this._mergeAggregates(results, aggType);
  }

  async compoundFilterParallel(data, count, filters, combineOp, dataType) {
    const validOps = filters.every(f => FILTER_OPS.has(f.operation));
    if (!validOps || !this.canParallelize(filters[0].operation, dataType, count)) {
      return this._compoundFilterFallback(data, count, filters, combineOp, dataType);
    }

    const bw = BYTE_WIDTH[dataType];
    const dataPtr = this._resolveDataPtr(data, count, bw);

    const workerCount = this.workerPool.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks = morsels.map(morsel => ({
      type: 'filter_compound',
      dataOffset: dataPtr + morsel.start * bw,
      count: morsel.length,
      filters,
      combineOp,
      dataType,
      baseIndex: morsel.start,
    }));

    const results = await this.workerPool.execute(tasks);
    return this._gatherSelectionVectors(results, count);
  }

  async pipelineParallel(data, count, dataType, stages) {
    const bw = BYTE_WIDTH[dataType];
    if (!PARALLELIZABLE_TYPES.has(dataType) || !this.workerPool || count < Config.parallelThreshold) {
      return this._pipelineFallback(data, count, dataType, stages);
    }

    const dataPtr = this._resolveDataPtr(data, count, bw);

    const workerCount = this.workerPool.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks = morsels.map(morsel => ({
      type: 'pipeline',
      dataOffset: dataPtr + morsel.start * bw,
      count: morsel.length,
      dataType,
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

  async projectParallel(data, count, op, params = {}) {
    if (!this.workerPool || count < Config.parallelThreshold || !PROJECT_OPS.has(op)) {
      return null;
    }

    const bw = data instanceof Float64Array ? 8 : 4;

    this.regionAllocator.resetStaging();
    const dataPtr = this.regionAllocator.allocStaging(count * bw);
    if (bw === 4) {
      new Int32Array(this.regionAllocator.memory.buffer, dataPtr, count).set(data.subarray(0, count));
    } else {
      new Float64Array(this.regionAllocator.memory.buffer, dataPtr, count).set(data.subarray(0, count));
    }

    let dataBPtr;
    if (params.dataB) {
      const bwB = params.dataB instanceof Float64Array ? 8 : 4;
      dataBPtr = this.regionAllocator.allocStaging(count * bwB);
      if (bwB === 4) {
        new Int32Array(this.regionAllocator.memory.buffer, dataBPtr, count).set(params.dataB.subarray(0, count));
      } else {
        new Float64Array(this.regionAllocator.memory.buffer, dataBPtr, count).set(params.dataB.subarray(0, count));
      }
    }

    const workerCount = this.workerPool.activeWorkerCount();
    const morsels = this._splitRange(count, workerCount);

    const tasks = morsels.map(morsel => {
      const task = {
        type: 'project',
        dataOffset: dataPtr + morsel.start * bw,
        count: morsel.length,
        op,
        scalar: params.scalar,
      };
      if (dataBPtr !== undefined) {
        const bwB = params.dataB instanceof Float64Array ? 8 : 4;
        task.dataBOffset = dataBPtr + morsel.start * bwB;
      }
      return task;
    });

    const results = await this.workerPool.execute(tasks);
    return this._gatherProjectResults(results, count);
  }

  _gatherProjectResults(results, totalCount) {
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

  _resolveDataPtr(data, count, bw) {
    if (data.buffer === this.regionAllocator.memory.buffer) {
      return data.byteOffset;
    }

    this.regionAllocator.resetStaging();
    const ptr = this.regionAllocator.allocStaging(count * bw);
    const memory = this.regionAllocator.memory;

    if (bw === 4) {
      new Int32Array(memory.buffer, ptr, count).set(data.subarray(0, count));
    } else {
      new Float64Array(memory.buffer, ptr, count).set(data.subarray(0, count));
    }

    return ptr;
  }

  _splitRange(totalCount, workerCount) {
    const morselCount = Math.max(workerCount, Math.ceil(totalCount / Config.morselSize));
    const morselSize = Math.ceil(totalCount / morselCount);
    const morsels = [];

    let offset = 0;
    while (offset < totalCount) {
      const length = Math.min(morselSize, totalCount - offset);
      morsels.push({ start: offset, length });
      offset += length;
    }

    return morsels;
  }

  _gatherSelectionVectors(results, totalCount) {
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

  _mergeAggregates(results, aggType) {
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

  _mergePipelineAggregates(results) {
    const aggMap = new Map();

    for (const r of results) {
      if (!r.aggregates) continue;
      for (const agg of r.aggregates) {
        if (!aggMap.has(agg.aggType)) {
          aggMap.set(agg.aggType, []);
        }
        aggMap.get(agg.aggType).push(agg);
      }
    }

    const merged = {};
    for (const [aggType, partials] of aggMap) {
      merged[aggType] = this._mergeAggregates(partials, aggType);
    }

    return { aggregates: merged };
  }

  async _compoundFilterFallback(data, count, filters, combineOp, dataType) {
    let svs = [];
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

  async _pipelineFallback(data, count, dataType, stages) {
    let sv = null;
    let aggResults = {};

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
          const result = await kernel(filtered);
          aggResults[stage.aggType] = { result, count: sv.length };
        } else {
          const result = await kernel(data);
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

  _gatherByIndices(data, indices, dataType) {
    const Ctor = dataType === 'FLOAT64' ? Float64Array : Int32Array;
    const out = new Ctor(indices.length);
    for (let i = 0; i < indices.length; i++) out[i] = data[indices[i]];
    return out;
  }

  _intersectSorted(a, b) {
    const out = new Uint32Array(Math.min(a.length, b.length));
    let i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { out[k++] = a[i]; i++; j++; }
      else if (a[i] < b[j]) i++;
      else j++;
    }
    return out.subarray(0, k);
  }

  _unionSorted(a, b) {
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

  async _filterFallback(operation, dataType, data, params) {
    const kernel = this.globalDispatch.lookup(operation, dataType);
    if (!kernel) return null;

    if (operation === 'filterBetween') {
      const sv = await kernel(data, params.low, params.high);
      return { selectionVector: sv, matchCount: sv.length };
    }

    const sv = await kernel(data, params.value);
    return { selectionVector: sv, matchCount: sv.length };
  }

  async _aggregateFallback(aggType, dataType, data) {
    const opKey = `${aggType}${dataType === 'INT32' ? 'I32' : 'F64'}`;
    const kernel = this.globalDispatch.lookup(opKey, dataType);
    if (!kernel) return null;

    const result = await kernel(data);
    return { result, count: data.length };
  }
}
