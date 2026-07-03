import { makeFilterKernel, makeBetweenKernel, makeScalarAggKernel } from './kernel-factory.js';

export const wasmFilterEqI32 = makeFilterKernel<Int32Array>('filterEqI32', 4);
export const wasmFilterLtI32 = makeFilterKernel<Int32Array>('filterLtI32', 4);
export const wasmFilterGtI32 = makeFilterKernel<Int32Array>('filterGtI32', 4);
export const wasmFilterBetweenI32 = makeBetweenKernel<Int32Array>('filterBetweenI32', 4);
export const wasmSumF64 = makeScalarAggKernel<Float64Array>('sumF64', 8);
