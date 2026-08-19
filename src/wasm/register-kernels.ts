import { DataType } from '../storage/data-type.js';
import { KernelOperand } from './wasm-types.js';
import { globalDispatch } from './dispatch.js';
import {
  wasmFilterEqI32,
  wasmFilterLtI32,
  wasmFilterGtI32,
  wasmFilterBetweenI32,
} from './kernels/wasm-filter.js';
import {
  wasmFilterEqF64,
  wasmFilterLtF64,
  wasmFilterGtF64,
  wasmFilterLeF64,
  wasmFilterGeF64,
  wasmFilterBetweenF64,
  wasmFilterLeI32,
  wasmFilterGeI32,
} from './kernels/wasm-filter-f64.js';
import {
  wasmSumI32,
  wasmSumF64,
  wasmMinI32,
  wasmMaxI32,
  wasmMinF64,
  wasmMaxF64,
} from './kernels/wasm-aggregate.js';
import {
  wasmVecAddF64,
  wasmVecSubF64,
  wasmVecMulF64,
  wasmVecDivF64,
  wasmScalarAddF64,
  wasmScalarSubF64,
  wasmScalarMulF64,
  wasmScalarDivF64,
  wasmScalarSubRevF64,
  wasmScalarDivRevF64,
  wasmWidenI32ToF64,
  wasmNegF64,
  wasmCountBits,
} from './kernels/wasm-arithmetic.js';

export function registerAllKernels(): void {
  globalDispatch.register('filterEq', DataType.INT32, wasmFilterEqI32);
  globalDispatch.register('filterLt', DataType.INT32, wasmFilterLtI32);
  globalDispatch.register('filterGt', DataType.INT32, wasmFilterGtI32);
  globalDispatch.register('filterLe', DataType.INT32, wasmFilterLeI32);
  globalDispatch.register('filterGe', DataType.INT32, wasmFilterGeI32);
  globalDispatch.register('filterBetween', DataType.INT32, wasmFilterBetweenI32);

  globalDispatch.register('filterEq', DataType.FLOAT64, wasmFilterEqF64);
  globalDispatch.register('filterLt', DataType.FLOAT64, wasmFilterLtF64);
  globalDispatch.register('filterGt', DataType.FLOAT64, wasmFilterGtF64);
  globalDispatch.register('filterLe', DataType.FLOAT64, wasmFilterLeF64);
  globalDispatch.register('filterGe', DataType.FLOAT64, wasmFilterGeF64);
  globalDispatch.register('filterBetween', DataType.FLOAT64, wasmFilterBetweenF64);

  globalDispatch.register('filterEq', DataType.DATE, wasmFilterEqI32);
  globalDispatch.register('filterLt', DataType.DATE, wasmFilterLtI32);
  globalDispatch.register('filterGt', DataType.DATE, wasmFilterGtI32);
  globalDispatch.register('filterLe', DataType.DATE, wasmFilterLeI32);
  globalDispatch.register('filterGe', DataType.DATE, wasmFilterGeI32);
  globalDispatch.register('filterBetween', DataType.DATE, wasmFilterBetweenI32);

  globalDispatch.register('sumI32', DataType.INT32, wasmSumI32);
  globalDispatch.register('sumF64', DataType.FLOAT64, wasmSumF64);
  globalDispatch.register('minI32', DataType.INT32, wasmMinI32);
  globalDispatch.register('maxI32', DataType.INT32, wasmMaxI32);
  globalDispatch.register('minF64', DataType.FLOAT64, wasmMinF64);
  globalDispatch.register('maxF64', DataType.FLOAT64, wasmMaxF64);

  globalDispatch.register('vecAddF64', DataType.FLOAT64, wasmVecAddF64);
  globalDispatch.register('vecSubF64', DataType.FLOAT64, wasmVecSubF64);
  globalDispatch.register('vecMulF64', DataType.FLOAT64, wasmVecMulF64);
  globalDispatch.register('vecDivF64', DataType.FLOAT64, wasmVecDivF64);

  globalDispatch.register('scalarAddF64', DataType.FLOAT64, wasmScalarAddF64);
  globalDispatch.register('scalarSubF64', DataType.FLOAT64, wasmScalarSubF64);
  globalDispatch.register('scalarMulF64', DataType.FLOAT64, wasmScalarMulF64);
  globalDispatch.register('scalarDivF64', DataType.FLOAT64, wasmScalarDivF64);
  globalDispatch.register('scalarSubRevF64', DataType.FLOAT64, wasmScalarSubRevF64);
  globalDispatch.register('scalarDivRevF64', DataType.FLOAT64, wasmScalarDivRevF64);

  globalDispatch.register('widenI32ToF64', DataType.INT32, wasmWidenI32ToF64);
  globalDispatch.register('negF64', DataType.FLOAT64, wasmNegF64);
  globalDispatch.register('countBits', KernelOperand.BITMAP, wasmCountBits);
}
