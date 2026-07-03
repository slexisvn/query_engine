import { getCoreInstance } from './core-instance.js';
import type { WasmExports } from '../wasm-types.js';
import { makeVecOpF64, makeScalarOpF64, makeScalarOpRevF64, makeUnaryOpF64 } from './kernel-factory.js';

export const wasmVecAddF64 = makeVecOpF64('vecAddF64');
export const wasmVecSubF64 = makeVecOpF64('vecSubF64');
export const wasmVecMulF64 = makeVecOpF64('vecMulF64');
export const wasmVecDivF64 = makeVecOpF64('vecDivF64');

export const wasmScalarAddF64 = makeScalarOpF64('scalarAddF64');
export const wasmScalarSubF64 = makeScalarOpF64('scalarSubF64');
export const wasmScalarMulF64 = makeScalarOpF64('scalarMulF64');
export const wasmScalarDivF64 = makeScalarOpF64('scalarDivF64');
export const wasmScalarSubRevF64 = makeScalarOpRevF64('scalarSubRevF64');
export const wasmScalarDivRevF64 = makeScalarOpRevF64('scalarDivRevF64');

export const wasmNegF64 = makeUnaryOpF64('negF64');

export async function wasmWidenI32ToF64(data: Int32Array): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  const outPtr = loader.alloc(count * 8);
  loader.writeI32Array(data, dataPtr);
  (instance.exports as WasmExports).widenI32ToF64(dataPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmCountBits(bitmap: Uint8Array, bitCount: number): Promise<number> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const wordCount = Math.ceil(bitCount / 32);
  const byteCount = wordCount * 4;
  const bitmapPtr = loader.alloc(byteCount);
  new Uint8Array(loader.getBuffer(), bitmapPtr, byteCount).set(
    new Uint8Array(bitmap.buffer, bitmap.byteOffset, byteCount)
  );
  return (instance.exports as WasmExports).countBitmapBits(bitmapPtr, bitCount);
}
