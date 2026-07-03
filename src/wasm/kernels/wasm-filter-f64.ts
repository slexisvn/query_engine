import { makeFilterKernel, makeBetweenKernel } from './kernel-factory.js';

export const wasmFilterEqF64 = makeFilterKernel<Float64Array>('filterEqF64', 8);
export const wasmFilterLtF64 = makeFilterKernel<Float64Array>('filterLtF64', 8);
export const wasmFilterGtF64 = makeFilterKernel<Float64Array>('filterGtF64', 8);
export const wasmFilterLeF64 = makeFilterKernel<Float64Array>('filterLeF64', 8);
export const wasmFilterGeF64 = makeFilterKernel<Float64Array>('filterGeF64', 8);
export const wasmFilterBetweenF64 = makeBetweenKernel<Float64Array>('filterBetweenF64', 8);
export const wasmFilterLeI32 = makeFilterKernel<Int32Array>('filterLeI32', 4);
export const wasmFilterGeI32 = makeFilterKernel<Int32Array>('filterGeI32', 4);
