import { getCoreInstance } from './core-instance.js';
import type { WasmExports } from '../wasm-types.js';

export async function wasmFilterEqI32(data: Int32Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterEqI32(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterLtI32(data: Int32Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterLtI32(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterGtI32(data: Int32Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterGtI32(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterBetweenI32(data: Int32Array, low: number, high: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterBetweenI32(dataPtr, selVecPtr, count, low, high);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmSumF64(data: Float64Array): Promise<number> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 8);
  return (instance.exports as WasmExports).sumF64(dataPtr, data.length);
}
