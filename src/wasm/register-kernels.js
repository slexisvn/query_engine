import { globalDispatch } from './dispatch.js';
import {
  wasmFilterEqI32,
  wasmFilterLtI32,
  wasmFilterGtI32,
  wasmFilterBetweenI32,
  wasmSumF64,
} from './kernels/wasm-filter.js';

export function registerAllKernels() {
  globalDispatch.register('filterEq', 'INT32', wasmFilterEqI32);
  globalDispatch.register('filterLt', 'INT32', wasmFilterLtI32);
  globalDispatch.register('filterGt', 'INT32', wasmFilterGtI32);
  globalDispatch.register('filterBetween', 'INT32', wasmFilterBetweenI32);
  globalDispatch.register('sumF64', 'FLOAT64', wasmSumF64);
}
