import { makeScalarAggKernel } from './kernel-factory.js';

export const wasmSumI32 = makeScalarAggKernel<Int32Array>('sumI32', 4);
export const wasmSumF64 = makeScalarAggKernel<Float64Array>('sumF64', 8);
export const wasmMinI32 = makeScalarAggKernel<Int32Array>('minI32', 4);
export const wasmMaxI32 = makeScalarAggKernel<Int32Array>('maxI32', 4);
export const wasmMinF64 = makeScalarAggKernel<Float64Array>('minF64', 8);
export const wasmMaxF64 = makeScalarAggKernel<Float64Array>('maxF64', 8);
