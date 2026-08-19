import { DataType } from '../storage/data-type.js';
export type WasmKernelFn = (...args: number[]) => number;

export interface WasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;

  readonly filterEqI32: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterLtI32: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterGtI32: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterLeI32: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterGeI32: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterBetweenI32: (dataPtr: number, selVecPtr: number, count: number, low: number, high: number) => number;

  readonly filterEqF64: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterLtF64: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterGtF64: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterLeF64: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterGeF64: (dataPtr: number, selVecPtr: number, count: number, value: number) => number;
  readonly filterBetweenF64: (dataPtr: number, selVecPtr: number, count: number, low: number, high: number) => number;

  readonly sumI32: (dataPtr: number, count: number) => number;
  readonly sumF64: (dataPtr: number, count: number) => number;
  readonly minI32: (dataPtr: number, count: number) => number;
  readonly maxI32: (dataPtr: number, count: number) => number;
  readonly minF64: (dataPtr: number, count: number) => number;
  readonly maxF64: (dataPtr: number, count: number) => number;

  readonly vecAddF64: (aPtr: number, bPtr: number, outPtr: number, count: number) => void;
  readonly vecSubF64: (aPtr: number, bPtr: number, outPtr: number, count: number) => void;
  readonly vecMulF64: (aPtr: number, bPtr: number, outPtr: number, count: number) => void;
  readonly vecDivF64: (aPtr: number, bPtr: number, outPtr: number, count: number) => void;

  readonly scalarAddF64: (dataPtr: number, scalar: number, outPtr: number, count: number) => void;
  readonly scalarSubF64: (dataPtr: number, scalar: number, outPtr: number, count: number) => void;
  readonly scalarMulF64: (dataPtr: number, scalar: number, outPtr: number, count: number) => void;
  readonly scalarDivF64: (dataPtr: number, scalar: number, outPtr: number, count: number) => void;
  readonly scalarSubRevF64: (scalar: number, dataPtr: number, outPtr: number, count: number) => void;
  readonly scalarDivRevF64: (scalar: number, dataPtr: number, outPtr: number, count: number) => void;

  readonly widenI32ToF64: (dataPtr: number, outPtr: number, count: number) => void;
  readonly negF64: (dataPtr: number, outPtr: number, count: number) => void;
  readonly countBitmapBits: (bitmapPtr: number, bitCount: number) => number;
}

export type WasmModuleName = 'core';

export interface RegionDescriptor {
  id: number;
  start: number;
  capacity: number;
  offset: number;
}

export interface RegionBounds {
  start: number;
  end: number;
}

export interface RegionUsage {
  used: number;
  capacity: number;
  free: number;
}

export interface RegionAllocatorLike {
  readonly memory: WebAssembly.Memory;
  readonly regionSize: number;
  addRegion(): number;
  alloc(regionId: number, bytes: number): number;
  reset(regionId: number): void;
  getRegionBounds(regionId: number): RegionBounds;
  getRegionUsage(regionId: number): RegionUsage;
  regionCount(): number;
  allocData(bytes: number): number;
  resetData(): void;
  allocStaging(bytes: number): number;
  resetStaging(): void;
}

export type TypedArrayCtor<T extends Int32Array | Float64Array | Uint32Array | Uint8Array> = {
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): T;
  readonly BYTES_PER_ELEMENT: number;
};

export interface WasmLoaderLike {
  memory: WebAssembly.Memory | null;
  loadModule(name: string): Promise<WebAssembly.Instance>;
  getModule(name: string): WebAssembly.Module | null;
  getModuleBytes(name: string): Uint8Array | null;
  alloc(bytes: number): number;
  reset(): void;
  getBuffer(): ArrayBufferLike;
  isShared(): boolean;
  isWasmBacked(data: Int32Array | Float64Array): boolean;
  resolveDataPtr(data: Int32Array | Float64Array, byteWidth: number): number;
  writeI32Array(data: Int32Array, ptr: number): void;
  writeF64Array(data: Float64Array, ptr: number): void;
  readI32Array(ptr: number, length: number): Int32Array;
  readF64Array(ptr: number, length: number): Float64Array;
  readF64(ptr: number): number;
  readU32Array(ptr: number, length: number): Uint32Array;
}

export type ByteSource = (name: string) => Promise<Uint8Array> | Uint8Array;

export type WasmVecData = Float64Array | Int32Array;

export type WasmKernelArg = Float64Array | Int32Array | Uint8Array | number;

export type WasmKernelResult = Float64Array | Int32Array | Uint32Array | number;

export type WasmKernel = (
  a: WasmVecData | number,
  b?: WasmVecData | number,
) => WasmVecData | Promise<WasmVecData>;

export type RegisterableKernel = {
  register(a: WasmKernelArg, b?: WasmKernelArg, c?: WasmKernelArg): Promise<WasmKernelResult> | WasmKernelResult;
}['register'];

export interface WasmDispatchRegistry {
  readonly kernels: Map<string, WasmKernel>;
  register(operation: string, dataType: string, kernel: RegisterableKernel): void;
  lookup(operation: string, dataType: string): WasmKernel | null;
  has(operation: string, dataType: string): boolean;
  setInstance(instance: WebAssembly.Instance, memory: WebAssembly.Memory): void;
  listKernels(): string[];
}

export const KernelOperand = {
  ...DataType,
  BITMAP: 'UINT8',
} as const;

export type KernelOperandType = typeof KernelOperand[keyof typeof KernelOperand];
