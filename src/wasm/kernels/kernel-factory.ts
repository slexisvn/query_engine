import { getCoreInstance } from './core-instance.js';
import type { WasmExports } from '../wasm-types.js';

type FilterExport = (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
type BetweenExport = (dataPtr: number, selVecPtr: number, count: number, low: number, high: number) => number;
type ScalarAggExport = (dataPtr: number, count: number) => number;
type VecOpExport = (aPtr: number, bPtr: number, outPtr: number, count: number) => void;
type ScalarOpExport = (dataPtr: number, scalar: number, outPtr: number, count: number) => void;
type ScalarOpRevExport = (scalar: number, dataPtr: number, outPtr: number, count: number) => void;
type UnaryOpExport = (dataPtr: number, outPtr: number, count: number) => void;

export function makeFilterKernel<T extends Int32Array | Float64Array>(
  exportName: keyof WasmExports,
  byteWidth: number
) {
  return async function (data: T, value: number): Promise<Uint32Array> {
    const { loader, instance } = await getCoreInstance();
    loader.reset();

    const count = data.length;
    const dataPtr = loader.resolveDataPtr(data, byteWidth);
    const selVecPtr = loader.alloc(count * 4);

    const matchCount = ((instance.exports as WasmExports)[exportName] as FilterExport)(dataPtr, selVecPtr, count, value);
    return loader.readU32Array(selVecPtr, matchCount);
  };
}

export function makeBetweenKernel<T extends Int32Array | Float64Array>(
  exportName: keyof WasmExports,
  byteWidth: number
) {
  return async function (data: T, low: number, high: number): Promise<Uint32Array> {
    const { loader, instance } = await getCoreInstance();
    loader.reset();

    const count = data.length;
    const dataPtr = loader.resolveDataPtr(data, byteWidth);
    const selVecPtr = loader.alloc(count * 4);

    const matchCount = ((instance.exports as WasmExports)[exportName] as BetweenExport)(dataPtr, selVecPtr, count, low, high);
    return loader.readU32Array(selVecPtr, matchCount);
  };
}

export function makeScalarAggKernel<T extends Int32Array | Float64Array>(
  exportName: keyof WasmExports,
  byteWidth: number
) {
  return async function (data: T): Promise<number> {
    const { loader, instance } = await getCoreInstance();
    loader.reset();

    const dataPtr = loader.resolveDataPtr(data, byteWidth);
    return ((instance.exports as WasmExports)[exportName] as ScalarAggExport)(dataPtr, data.length);
  };
}

export function makeVecOpF64(exportName: keyof WasmExports) {
  return async function (a: Float64Array, b: Float64Array): Promise<Float64Array> {
    const { loader, instance } = await getCoreInstance();
    loader.reset();
    const count = a.length;
    const aPtr = loader.alloc(count * 8);
    const bPtr = loader.alloc(count * 8);
    const outPtr = loader.alloc(count * 8);
    loader.writeF64Array(a, aPtr);
    loader.writeF64Array(b, bPtr);
    ((instance.exports as WasmExports)[exportName] as VecOpExport)(aPtr, bPtr, outPtr, count);
    return loader.readF64Array(outPtr, count);
  };
}

export function makeScalarOpF64(exportName: keyof WasmExports) {
  return async function (data: Float64Array, scalar: number): Promise<Float64Array> {
    const { loader, instance } = await getCoreInstance();
    loader.reset();
    const count = data.length;
    const dataPtr = loader.alloc(count * 8);
    const outPtr = loader.alloc(count * 8);
    loader.writeF64Array(data, dataPtr);
    ((instance.exports as WasmExports)[exportName] as ScalarOpExport)(dataPtr, scalar, outPtr, count);
    return loader.readF64Array(outPtr, count);
  };
}

export function makeScalarOpRevF64(exportName: keyof WasmExports) {
  return async function (scalar: number, data: Float64Array): Promise<Float64Array> {
    const { loader, instance } = await getCoreInstance();
    loader.reset();
    const count = data.length;
    const dataPtr = loader.alloc(count * 8);
    const outPtr = loader.alloc(count * 8);
    loader.writeF64Array(data, dataPtr);
    ((instance.exports as WasmExports)[exportName] as ScalarOpRevExport)(scalar, dataPtr, outPtr, count);
    return loader.readF64Array(outPtr, count);
  };
}

export function makeUnaryOpF64(exportName: keyof WasmExports) {
  return async function (data: Float64Array): Promise<Float64Array> {
    const { loader, instance } = await getCoreInstance();
    loader.reset();
    const count = data.length;
    const dataPtr = loader.alloc(count * 8);
    const outPtr = loader.alloc(count * 8);
    loader.writeF64Array(data, dataPtr);
    ((instance.exports as WasmExports)[exportName] as UnaryOpExport)(dataPtr, outPtr, count);
    return loader.readF64Array(outPtr, count);
  };
}
