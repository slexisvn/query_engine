import { getCoreInstance } from './core-instance.js';
import type { WasmExports } from '../wasm-types.js';

export async function wasmFilterEqF64(data: Float64Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 8);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterEqF64(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterLtF64(data: Float64Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 8);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterLtF64(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterGtF64(data: Float64Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 8);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterGtF64(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterLeF64(data: Float64Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 8);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterLeF64(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterGeF64(data: Float64Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 8);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterGeF64(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterBetweenF64(data: Float64Array, low: number, high: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 8);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterBetweenF64(dataPtr, selVecPtr, count, low, high);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterLeI32(data: Int32Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterLeI32(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterGeI32(data: Int32Array, value: number): Promise<Uint32Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = (instance.exports as WasmExports).filterGeI32(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}
