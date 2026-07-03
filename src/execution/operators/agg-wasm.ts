import { globalDispatch } from '../../wasm/dispatch.js';
import { DataType } from '../../storage/data-type.js';

type GlobalDispatch = typeof globalDispatch;

interface AggregateDef {
  name: string;
  resultType: DataType;
}

export interface ResolvedKernel {
  kernelKey: string | null;
  dataType: string | null;
  kind: string;
}

export type ScalarReduceKernel = (data: Float64Array | Int32Array) => number | Promise<number>;
export type BitmapCountKernel = (bitmap: Uint32Array, count: number) => number | Promise<number>;

export function resolveWasmAggKernel(def: AggregateDef, globalDispatch: GlobalDispatch): ResolvedKernel | null {
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
