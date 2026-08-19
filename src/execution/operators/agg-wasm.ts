import { globalDispatch } from '../../wasm/dispatch.js';
import { DataType } from '../../storage/data-type.js';
import { KernelOperand, type KernelOperandType } from '../../wasm/wasm-types.js';

type GlobalDispatch = typeof globalDispatch;

interface AggregateDef {
  name: string;
  resultType: DataType;
  distinct?: boolean;
}

export interface ResolvedKernel {
  kernelKey: string | null;
  operand: KernelOperandType | null;
  kind: string;
}

export type ScalarReduceKernel = (data: Float64Array | Int32Array) => number | Promise<number>;
export type BitmapCountKernel = (bitmap: Uint32Array, count: number) => number | Promise<number>;

export function resolveWasmAggKernel(def: AggregateDef, globalDispatch: GlobalDispatch): ResolvedKernel | null {
  const name = def.name?.toUpperCase();
  if (!name || def.distinct) return null;

  if (name === 'SUM' && def.resultType === DataType.FLOAT64) {
    if (globalDispatch.has('sumF64', DataType.FLOAT64)) return { kernelKey: 'sumF64', operand: DataType.FLOAT64, kind: 'SUM' };
    if (globalDispatch.has('sumI32', DataType.INT32)) return { kernelKey: 'sumI32', operand: DataType.INT32, kind: 'SUM' };
  }
  if (name === 'MIN') {
    if (def.resultType === DataType.FLOAT64 && globalDispatch.has('minF64', DataType.FLOAT64)) return { kernelKey: 'minF64', operand: DataType.FLOAT64, kind: 'MIN' };
    if (def.resultType === DataType.INT32 && globalDispatch.has('minI32', DataType.INT32)) return { kernelKey: 'minI32', operand: DataType.INT32, kind: 'MIN' };
  }
  if (name === 'MAX') {
    if (def.resultType === DataType.FLOAT64 && globalDispatch.has('maxF64', DataType.FLOAT64)) return { kernelKey: 'maxF64', operand: DataType.FLOAT64, kind: 'MAX' };
    if (def.resultType === DataType.INT32 && globalDispatch.has('maxI32', DataType.INT32)) return { kernelKey: 'maxI32', operand: DataType.INT32, kind: 'MAX' };
  }
  if (name === 'COUNT') {
    return { kernelKey: 'countBits', operand: KernelOperand.BITMAP, kind: 'COUNT' };
  }
  if (name === 'COUNT_STAR') {
    return { kernelKey: null, operand: null, kind: 'COUNT_STAR' };
  }
  if (name === 'AVG' && def.resultType === DataType.FLOAT64) {
    if (globalDispatch.has('sumF64', DataType.FLOAT64)) return { kernelKey: 'sumF64', operand: DataType.FLOAT64, kind: 'AVG' };
  }
  return null;
}
