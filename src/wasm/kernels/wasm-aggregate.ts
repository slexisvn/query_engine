import { getCoreInstance } from './core-instance.js';
import type { WasmExports } from '../wasm-types.js';

export async function wasmSumI32(data: Int32Array): Promise<number> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 4);
  return (instance.exports as WasmExports).sumI32(dataPtr, data.length);
}

export async function wasmSumF64(data: Float64Array): Promise<number> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 8);
  return (instance.exports as WasmExports).sumF64(dataPtr, data.length);
}

export async function wasmMinI32(data: Int32Array): Promise<number> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 4);
  return (instance.exports as WasmExports).minI32(dataPtr, data.length);
}

export async function wasmMaxI32(data: Int32Array): Promise<number> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 4);
  return (instance.exports as WasmExports).maxI32(dataPtr, data.length);
}

export async function wasmMinF64(data: Float64Array): Promise<number> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 8);
  return (instance.exports as WasmExports).minF64(dataPtr, data.length);
}

export async function wasmMaxF64(data: Float64Array): Promise<number> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 8);
  return (instance.exports as WasmExports).maxF64(dataPtr, data.length);
}
