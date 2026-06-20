import { RegionAllocator } from './region-allocator.js';
import type {
  RegionAllocatorLike,
  TypedArrayCtor,
  WasmExports,
} from './wasm-types.js';

export const WASM_PAGE_SIZE = 65536;
export const INITIAL_PAGES = 256;
export const MAX_PAGES = 16384;

const ALIGNMENT = 16;
const BYTE_WIDTH_I32 = 4;
const BYTE_WIDTH_F64 = 8;

export abstract class WasmLoaderBase {
  memory: WebAssembly.Memory | null;
  instances: Map<string, WebAssembly.Instance>;
  modules: Map<string, WebAssembly.Module>;
  moduleBytes: Map<string, Uint8Array>;
  bumpOffset: number;
  regionAllocator: RegionAllocatorLike | null;
  shared: boolean;

  constructor() {
    this.memory = null;
    this.instances = new Map();
    this.modules = new Map();
    this.moduleBytes = new Map();
    this.bumpOffset = 0;
    this.regionAllocator = null;
    this.shared = false;
  }

  abstract init(): Promise<void>;

  initRegions(regionSize: number): RegionAllocatorLike {
    if (!this.memory) throw new Error('Memory not initialized — call init() first');
    this.regionAllocator = new RegionAllocator(this.memory, regionSize) as RegionAllocatorLike;
    return this.regionAllocator;
  }

  async fetchModuleBytes(_name: string): Promise<Uint8Array> {
    throw new Error('fetchModuleBytes must be implemented by a platform loader');
  }

  async loadModule(name: string): Promise<WebAssembly.Instance> {
    if (this.instances.has(name)) return this.instances.get(name) as WebAssembly.Instance;

    if (!this.memory) await this.init();

    const buffer = await this.fetchModuleBytes(name);
    this.moduleBytes.set(name, buffer);

    const module = await WebAssembly.compile(buffer as BufferSource);
    this.modules.set(name, module);

    const imports = WebAssembly.Module.imports(module);
    const needsMemoryImport = imports.some(i => i.name === 'memory');

    const instance = await WebAssembly.instantiate(module, {
      env: needsMemoryImport ? { memory: this.memory as WebAssembly.Memory } : {},
    });

    if (!needsMemoryImport && (instance.exports as WasmExports).memory) {
      this.memory = (instance.exports as WasmExports).memory;
    }

    this.instances.set(name, instance);
    return instance;
  }

  getModule(name: string): WebAssembly.Module | null {
    return this.modules.get(name) || null;
  }

  getModuleBytes(name: string): Uint8Array | null {
    return this.moduleBytes.get(name) || null;
  }

  alloc(bytes: number): number {
    const aligned = (this.bumpOffset + ALIGNMENT - 1) & ~(ALIGNMENT - 1);
    const paddedBytes = bytes + ALIGNMENT;
    const newOffset = aligned + paddedBytes;
    const totalBytes = this.memory!.buffer.byteLength;
    if (newOffset > totalBytes) {
      const pagesNeeded = Math.ceil((newOffset - totalBytes) / WASM_PAGE_SIZE);
      this.memory!.grow(pagesNeeded);
    }
    this.bumpOffset = newOffset;
    return aligned;
  }

  reset(): void {
    this.bumpOffset = 0;
  }

  getBuffer(): ArrayBufferLike {
    return this.memory!.buffer;
  }

  isShared(): boolean {
    return this.shared;
  }

  isWasmBacked(data: Int32Array | Float64Array): boolean {
    return data.buffer === this.memory!.buffer;
  }

  allocTypedArray<T extends Int32Array | Float64Array | Uint32Array | Uint8Array>(
    TypedArrayCtor: TypedArrayCtor<T>,
    length: number,
  ): T | null {
    if (!this.regionAllocator) return null;
    const bw = TypedArrayCtor.BYTES_PER_ELEMENT;
    const ptr = this.regionAllocator.allocData(length * bw);
    return new TypedArrayCtor(this.memory!.buffer, ptr, length);
  }

  resolveDataPtr(data: Int32Array | Float64Array, byteWidth: number): number {
    if (this.isWasmBacked(data)) return data.byteOffset;
    const bytes = data.length * byteWidth;
    const ptr = this.alloc(bytes);
    if (byteWidth === BYTE_WIDTH_I32) this.writeI32Array(data as Int32Array, ptr);
    else this.writeF64Array(data as Float64Array, ptr);
    return ptr;
  }

  writeI32Array(data: Int32Array, ptr: number): void {
    new Int32Array(this.memory!.buffer, ptr, data.length).set(data);
  }

  writeF64Array(data: Float64Array, ptr: number): void {
    new Float64Array(this.memory!.buffer, ptr, data.length).set(data);
  }

  readI32Array(ptr: number, length: number): Int32Array {
    return new Int32Array(this.memory!.buffer.slice(ptr, ptr + length * BYTE_WIDTH_I32));
  }

  readF64Array(ptr: number, length: number): Float64Array {
    return new Float64Array(this.memory!.buffer.slice(ptr, ptr + length * BYTE_WIDTH_F64));
  }

  readF64(ptr: number): number {
    return new Float64Array(this.memory!.buffer, ptr, 1)[0];
  }

  readU32Array(ptr: number, length: number): Uint32Array {
    return new Uint32Array(this.memory!.buffer.slice(ptr, ptr + length * BYTE_WIDTH_I32));
  }
}
