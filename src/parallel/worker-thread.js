import { parentPort, workerData } from 'worker_threads';

const { wasmModule, wasmMemory, regionId, regionStart, regionCapacity } = workerData;

const ALIGNMENT = 16;
let bumpOffset = 0;
let instance = null;

function alloc(bytes) {
  const aligned = (bumpOffset + ALIGNMENT - 1) & ~(ALIGNMENT - 1);
  const needed = aligned + bytes;
  if (needed > regionCapacity) {
    throw new RangeError(`Region ${regionId} overflow: need ${needed}, have ${regionCapacity}`);
  }
  bumpOffset = needed;
  return regionStart + aligned;
}

function reset() {
  bumpOffset = 0;
}

const BYTE_WIDTH = { INT32: 4, FLOAT64: 8, DATE: 4 };

const FILTER_EXPORT_MAP = {
  'filterEq:INT32': 'filterEqI32',
  'filterLt:INT32': 'filterLtI32',
  'filterGt:INT32': 'filterGtI32',
  'filterLe:INT32': 'filterLeI32',
  'filterGe:INT32': 'filterGeI32',
  'filterEq:FLOAT64': 'filterEqF64',
  'filterLt:FLOAT64': 'filterLtF64',
  'filterGt:FLOAT64': 'filterGtF64',
  'filterLe:FLOAT64': 'filterLeF64',
  'filterGe:FLOAT64': 'filterGeF64',
  'filterEq:DATE': 'filterEqI32',
  'filterLt:DATE': 'filterLtI32',
  'filterGt:DATE': 'filterGtI32',
  'filterLe:DATE': 'filterLeI32',
  'filterGe:DATE': 'filterGeI32',
};

const BETWEEN_EXPORT_MAP = {
  INT32: 'filterBetweenI32',
  FLOAT64: 'filterBetweenF64',
  DATE: 'filterBetweenI32',
};

const AGG_EXPORT_MAP = {
  'sum:INT32': 'sumI32',
  'sum:FLOAT64': 'sumF64',
  'min:INT32': 'minI32',
  'max:INT32': 'maxI32',
  'min:FLOAT64': 'minF64',
  'max:FLOAT64': 'maxF64',
};

const GATHER_AGG_EXPORT_MAP = {
  'sum:INT32': 'gatherSumI32',
  'sum:FLOAT64': 'gatherSumF64',
  'min:INT32': 'gatherMinI32',
  'max:INT32': 'gatherMaxI32',
  'min:FLOAT64': 'gatherMinF64',
  'max:FLOAT64': 'gatherMaxF64',
};

const CMP_OP_CODE = {
  filterEq: 0,
  filterLt: 1,
  filterGt: 2,
  filterLe: 3,
  filterGe: 4,
};

const COMPOUND_AND_EXPORT = { INT32: 'filterCompoundAndI32', FLOAT64: 'filterCompoundAndF64', DATE: 'filterCompoundAndI32' };
const COMPOUND_OR_EXPORT = { INT32: 'filterCompoundOrI32', FLOAT64: 'filterCompoundOrF64', DATE: 'filterCompoundOrI32' };
const COMPOUND_N_AND_EXPORT = { INT32: 'filterCompoundAndNI32', FLOAT64: 'filterCompoundAndNF64', DATE: 'filterCompoundAndNI32' };
const COMPOUND_N_OR_EXPORT = { INT32: 'filterCompoundOrNI32', FLOAT64: 'filterCompoundOrNF64', DATE: 'filterCompoundOrNI32' };

function runFilter(dataOffset, count, operation, dataType, params) {
  const selVecPtr = alloc(count * 4);

  let matchCount;
  if (operation === 'filterBetween') {
    const exportName = BETWEEN_EXPORT_MAP[dataType];
    matchCount = instance.exports[exportName](dataOffset, selVecPtr, count, params.low, params.high);
  } else {
    const key = `${operation}:${dataType}`;
    const exportName = FILTER_EXPORT_MAP[key];
    matchCount = instance.exports[exportName](dataOffset, selVecPtr, count, params.value);
  }

  return { selVecPtr, matchCount };
}

function intersectSV(ptrA, lenA, ptrB, lenB) {
  const buf = wasmMemory.buffer;
  const a = new Uint32Array(buf, ptrA, lenA);
  const b = new Uint32Array(buf, ptrB, lenB);
  const outPtr = alloc(Math.min(lenA, lenB) * 4);
  const out = new Uint32Array(buf, outPtr, Math.min(lenA, lenB));

  let i = 0, j = 0, k = 0;
  while (i < lenA && j < lenB) {
    if (a[i] === b[j]) { out[k++] = a[i]; i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }

  return { selVecPtr: outPtr, matchCount: k };
}

function unionSV(ptrA, lenA, ptrB, lenB) {
  const buf = wasmMemory.buffer;
  const a = new Uint32Array(buf, ptrA, lenA);
  const b = new Uint32Array(buf, ptrB, lenB);
  const outPtr = alloc((lenA + lenB) * 4);
  const out = new Uint32Array(buf, outPtr, lenA + lenB);

  let i = 0, j = 0, k = 0;
  while (i < lenA && j < lenB) {
    if (a[i] === b[j]) { out[k++] = a[i]; i++; j++; }
    else if (a[i] < b[j]) { out[k++] = a[i]; i++; }
    else { out[k++] = b[j]; j++; }
  }
  while (i < lenA) out[k++] = a[i++];
  while (j < lenB) out[k++] = b[j++];

  return { selVecPtr: outPtr, matchCount: k };
}

function handleFilter(msg) {
  reset();

  const { dataOffset, count, operation, dataType, baseIndex } = msg;
  const { selVecPtr, matchCount } = runFilter(dataOffset, count, operation, dataType, msg);

  if (baseIndex !== 0) {
    const sv = new Uint32Array(wasmMemory.buffer, selVecPtr, matchCount);
    for (let i = 0; i < matchCount; i++) sv[i] += baseIndex;
  }

  return { matchCount, selVecPtr };
}

function handleAggregate(msg) {
  const { dataOffset, count, aggType, dataType } = msg;

  const key = `${aggType}:${dataType}`;
  const exportName = AGG_EXPORT_MAP[key];
  const result = instance.exports[exportName](dataOffset, count);

  return { result, count };
}

function canFuseCompound(filters) {
  return filters.every(f => f.operation in CMP_OP_CODE);
}

function fusedCompoundFilter(dataOffset, count, filters, combineOp, dataType) {
  if (filters.length === 2) {
    const selVecPtr = alloc(count * 4);
    const exportMap = combineOp === 'or' ? COMPOUND_OR_EXPORT : COMPOUND_AND_EXPORT;
    const exportName = exportMap[dataType];
    const op1 = CMP_OP_CODE[filters[0].operation];
    const op2 = CMP_OP_CODE[filters[1].operation];
    const matchCount = instance.exports[exportName](dataOffset, selVecPtr, count, op1, filters[0].value, op2, filters[1].value);
    return { selVecPtr, matchCount };
  }

  const valBytes = dataType === 'FLOAT64' ? 8 : 4;
  const opsPtr = alloc(filters.length * 4);
  const valsPtr = alloc(filters.length * valBytes);
  const selVecPtr = alloc(count * 4);

  const opsBuf = new Int32Array(wasmMemory.buffer, opsPtr, filters.length);
  for (let i = 0; i < filters.length; i++) opsBuf[i] = CMP_OP_CODE[filters[i].operation];

  if (dataType === 'FLOAT64') {
    const valsBuf = new Float64Array(wasmMemory.buffer, valsPtr, filters.length);
    for (let i = 0; i < filters.length; i++) valsBuf[i] = filters[i].value;
  } else {
    const valsBuf = new Int32Array(wasmMemory.buffer, valsPtr, filters.length);
    for (let i = 0; i < filters.length; i++) valsBuf[i] = filters[i].value;
  }

  const exportMap = combineOp === 'or' ? COMPOUND_N_OR_EXPORT : COMPOUND_N_AND_EXPORT;
  const matchCount = instance.exports[exportMap[dataType]](dataOffset, selVecPtr, count, opsPtr, valsPtr, filters.length);

  return { selVecPtr, matchCount };
}

function handleFilterCompound(msg) {
  reset();

  const { dataOffset, count, filters, combineOp, dataType, baseIndex } = msg;

  let result;
  if (canFuseCompound(filters)) {
    result = fusedCompoundFilter(dataOffset, count, filters, combineOp, dataType);
  } else {
    let current = runFilter(dataOffset, count, filters[0].operation, dataType, filters[0]);
    const merge = combineOp === 'or' ? unionSV : intersectSV;
    for (let i = 1; i < filters.length; i++) {
      const next = runFilter(dataOffset, count, filters[i].operation, dataType, filters[i]);
      current = merge(current.selVecPtr, current.matchCount, next.selVecPtr, next.matchCount);
    }
    result = current;
  }

  if (baseIndex !== 0) {
    const sv = new Uint32Array(wasmMemory.buffer, result.selVecPtr, result.matchCount);
    for (let i = 0; i < result.matchCount; i++) sv[i] += baseIndex;
  }

  return { matchCount: result.matchCount, selVecPtr: result.selVecPtr };
}

function gatherAggregate(dataOffset, dataCount, svPtr, svLen, aggType, dataType) {
  if (svLen === 0) return 0;

  const key = `${aggType}:${dataType}`;
  const exportName = GATHER_AGG_EXPORT_MAP[key];

  if (exportName) {
    return instance.exports[exportName](dataOffset, svPtr, svLen);
  }

  return 0;
}

function processPipelineFilters(dataOffset, count, dataType, filters) {
  if (filters.length === 1) {
    return runFilter(dataOffset, count, filters[0].operation, dataType, filters[0]);
  }

  if (canFuseCompound(filters)) {
    return fusedCompoundFilter(dataOffset, count, filters, 'and', dataType);
  }

  let current = runFilter(dataOffset, count, filters[0].operation, dataType, filters[0]);
  for (let i = 1; i < filters.length; i++) {
    const next = runFilter(dataOffset, count, filters[i].operation, dataType, filters[i]);
    current = intersectSV(current.selVecPtr, current.matchCount, next.selVecPtr, next.matchCount);
  }
  return current;
}

function handlePipeline(msg) {
  reset();

  const { dataOffset, count, dataType, baseIndex, stages } = msg;

  let svPtr = null;
  let svLen = 0;
  let aggResults = [];
  const filterStages = [];
  let filtersProcessed = false;

  const processFilters = () => {
    if (filtersProcessed || filterStages.length === 0) return;
    const result = processPipelineFilters(dataOffset, count, dataType, filterStages);
    svPtr = result.selVecPtr;
    svLen = result.matchCount;
    filtersProcessed = true;
  };

  for (const stage of stages) {
    if (stage.kind === 'filter') {
      filterStages.push(stage);
    } else {
      processFilters();
      if (stage.kind === 'aggregate') {
        if (svPtr !== null) {
          const result = gatherAggregate(dataOffset, count, svPtr, svLen, stage.aggType, dataType);
          aggResults.push({ aggType: stage.aggType, result, count: svLen });
        } else {
          const key = `${stage.aggType}:${dataType}`;
          const result = instance.exports[AGG_EXPORT_MAP[key]](dataOffset, count);
          aggResults.push({ aggType: stage.aggType, result, count });
        }
      } else if (stage.kind === 'count') {
        aggResults.push({ aggType: 'count', result: svPtr !== null ? svLen : count, count: svPtr !== null ? svLen : count });
      }
    }
  }

  processFilters();

  if (aggResults.length > 0) {
    return { aggregates: aggResults };
  }

  if (svPtr !== null) {
    if (baseIndex !== 0) {
      const sv = new Uint32Array(wasmMemory.buffer, svPtr, svLen);
      for (let i = 0; i < svLen; i++) sv[i] += baseIndex;
    }
    return { matchCount: svLen, selVecPtr: svPtr };
  }

  return { matchCount: count, selVecPtr: null };
}

function handleProject(msg) {
  reset();
  const { dataOffset, dataBOffset, count, op, scalar } = msg;
  const outPtr = alloc(count * 8);

  if (op === 'widenI32ToF64') {
    instance.exports.widenI32ToF64(dataOffset, outPtr, count);
  } else if (op === 'negF64') {
    instance.exports.negF64(dataOffset, outPtr, count);
  } else if (op === 'scalarSubRevF64') {
    instance.exports.scalarSubRevF64(scalar, dataOffset, outPtr, count);
  } else if (op === 'scalarDivRevF64') {
    instance.exports.scalarDivRevF64(scalar, dataOffset, outPtr, count);
  } else if (op.startsWith('scalar')) {
    instance.exports[op](dataOffset, scalar, outPtr, count);
  } else {
    instance.exports[op](dataOffset, dataBOffset, outPtr, count);
  }

  return { resultOffset: outPtr, count };
}

const HANDLERS = {
  filter: handleFilter,
  aggregate: handleAggregate,
  filter_compound: handleFilterCompound,
  pipeline: handlePipeline,
  project: handleProject,
};

async function initialize() {
  instance = await WebAssembly.instantiate(wasmModule, {
    env: { memory: wasmMemory },
  });

  parentPort.postMessage({ type: 'ready', workerId: workerData.workerId });
}

parentPort.on('message', (msg) => {
  const { taskId, type } = msg;
  const handler = HANDLERS[type];

  if (!handler) {
    parentPort.postMessage({ type: 'error', taskId, error: `Unknown task type: ${type}` });
    return;
  }

  try {
    const data = handler(msg);
    const transfer = [];
    if (data.selVecPtr != null && data.matchCount > 0) {
      const sv = new Uint32Array(data.matchCount);
      sv.set(new Uint32Array(wasmMemory.buffer, data.selVecPtr, data.matchCount));
      data.selectionVector = sv;
      transfer.push(sv.buffer);
    }
    delete data.selVecPtr;
    if (data.resultOffset != null && data.count > 0) {
      const result = new Float64Array(data.count);
      result.set(new Float64Array(wasmMemory.buffer, data.resultOffset, data.count));
      data.resultData = result;
      transfer.push(result.buffer);
    }
    delete data.resultOffset;
    parentPort.postMessage({ type: 'result', taskId, data }, transfer);
  } catch (err) {
    parentPort.postMessage({ type: 'error', taskId, error: err.message });
  }
});

initialize().catch(err => {
  parentPort.postMessage({ type: 'error', taskId: -1, error: err.message });
  process.exit(1);
});
