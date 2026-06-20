import { getGlobalLoader } from '../loader.js';
import type { WasmExports, WasmLoaderLike } from '../wasm-types.js';

interface CoreInstance {
  loader: WasmLoaderLike;
  instance: WebAssembly.Instance;
}

let _coreInstance: CoreInstance | null = null;

async function getCoreInstance(): Promise<CoreInstance> {
  if (_coreInstance) return _coreInstance;
  const loader = await getGlobalLoader();
  _coreInstance = { loader, instance: await loader.loadModule('core') };
  return _coreInstance;
}

export async function wasmVecAddF64(a: Float64Array, b: Float64Array): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = a.length;
  const aPtr = loader.alloc(count * 8);
  const bPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(a, aPtr);
  loader.writeF64Array(b, bPtr);
  (instance.exports as WasmExports).vecAddF64(aPtr, bPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmVecSubF64(a: Float64Array, b: Float64Array): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = a.length;
  const aPtr = loader.alloc(count * 8);
  const bPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(a, aPtr);
  loader.writeF64Array(b, bPtr);
  (instance.exports as WasmExports).vecSubF64(aPtr, bPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmVecMulF64(a: Float64Array, b: Float64Array): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = a.length;
  const aPtr = loader.alloc(count * 8);
  const bPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(a, aPtr);
  loader.writeF64Array(b, bPtr);
  (instance.exports as WasmExports).vecMulF64(aPtr, bPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmVecDivF64(a: Float64Array, b: Float64Array): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = a.length;
  const aPtr = loader.alloc(count * 8);
  const bPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(a, aPtr);
  loader.writeF64Array(b, bPtr);
  (instance.exports as WasmExports).vecDivF64(aPtr, bPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarAddF64(data: Float64Array, scalar: number): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  (instance.exports as WasmExports).scalarAddF64(dataPtr, scalar, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarSubF64(data: Float64Array, scalar: number): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  (instance.exports as WasmExports).scalarSubF64(dataPtr, scalar, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarMulF64(data: Float64Array, scalar: number): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  (instance.exports as WasmExports).scalarMulF64(dataPtr, scalar, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarDivF64(data: Float64Array, scalar: number): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  (instance.exports as WasmExports).scalarDivF64(dataPtr, scalar, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarSubRevF64(scalar: number, data: Float64Array): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  (instance.exports as WasmExports).scalarSubRevF64(scalar, dataPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarDivRevF64(scalar: number, data: Float64Array): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  (instance.exports as WasmExports).scalarDivRevF64(scalar, dataPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

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

export async function wasmNegF64(data: Float64Array): Promise<Float64Array> {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  (instance.exports as WasmExports).negF64(dataPtr, outPtr, count);
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
