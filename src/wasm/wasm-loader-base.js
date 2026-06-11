import { RegionAllocator } from './region-allocator.js';

export const WASM_PAGE_SIZE = 65536;
export const INITIAL_PAGES = 256;
export const MAX_PAGES = 16384;

const ALIGNMENT = 16;
const BYTE_WIDTH_I32 = 4;
const BYTE_WIDTH_F64 = 8;

export class WasmLoaderBase {
  constructor() {
    this.memory = null;
    this.instances = new Map();
    this.modules = new Map();
    this.moduleBytes = new Map();
    this.bumpOffset = 0;
    this.regionAllocator = null;
    this.shared = false;
  }

  initRegions(regionSize) {
    if (!this.memory) throw new Error('Memory not initialized — call init() first');
    this.regionAllocator = new RegionAllocator(this.memory, regionSize);
    return this.regionAllocator;
  }

  async fetchModuleBytes(_name) {
    throw new Error('fetchModuleBytes must be implemented by a platform loader');
  }

  async loadModule(name) {
    if (this.instances.has(name)) return this.instances.get(name);

    if (!this.memory) await this.init();

    const buffer = await this.fetchModuleBytes(name);
    this.moduleBytes.set(name, buffer);

    const module = await WebAssembly.compile(buffer);
    this.modules.set(name, module);

    const imports = WebAssembly.Module.imports(module);
    const needsMemoryImport = imports.some(i => i.name === 'memory');

    const instance = await WebAssembly.instantiate(module, {
      env: needsMemoryImport ? { memory: this.memory } : {},
    });

    if (!needsMemoryImport && instance.exports.memory) {
      this.memory = instance.exports.memory;
    }

    this.instances.set(name, instance);
    return instance;
  }

  getModule(name) {
    return this.modules.get(name) || null;
  }

  getModuleBytes(name) {
    return this.moduleBytes.get(name) || null;
  }

  alloc(bytes) {
    const aligned = (this.bumpOffset + ALIGNMENT - 1) & ~(ALIGNMENT - 1);
    const paddedBytes = bytes + ALIGNMENT;
    const newOffset = aligned + paddedBytes;
    const totalBytes = this.memory.buffer.byteLength;
    if (newOffset > totalBytes) {
      const pagesNeeded = Math.ceil((newOffset - totalBytes) / WASM_PAGE_SIZE);
      this.memory.grow(pagesNeeded);
    }
    this.bumpOffset = newOffset;
    return aligned;
  }

  reset() {
    this.bumpOffset = 0;
  }

  getBuffer() {
    return this.memory.buffer;
  }

  isShared() {
    return this.shared;
  }

  isWasmBacked(data) {
    return data.buffer === this.memory.buffer;
  }

  allocTypedArray(TypedArrayCtor, length) {
    if (!this.regionAllocator) return null;
    const bw = TypedArrayCtor.BYTES_PER_ELEMENT;
    const ptr = this.regionAllocator.allocData(length * bw);
    return new TypedArrayCtor(this.memory.buffer, ptr, length);
  }

  resolveDataPtr(data, byteWidth) {
    if (this.isWasmBacked(data)) return data.byteOffset;
    const bytes = data.length * byteWidth;
    const ptr = this.alloc(bytes);
    if (byteWidth === BYTE_WIDTH_I32) this.writeI32Array(data, ptr);
    else this.writeF64Array(data, ptr);
    return ptr;
  }

  writeI32Array(data, ptr) {
    new Int32Array(this.memory.buffer, ptr, data.length).set(data);
  }

  writeF64Array(data, ptr) {
    new Float64Array(this.memory.buffer, ptr, data.length).set(data);
  }

  readI32Array(ptr, length) {
    return new Int32Array(this.memory.buffer.slice(ptr, ptr + length * BYTE_WIDTH_I32));
  }

  readF64Array(ptr, length) {
    return new Float64Array(this.memory.buffer.slice(ptr, ptr + length * BYTE_WIDTH_F64));
  }

  readF64(ptr) {
    return new Float64Array(this.memory.buffer, ptr, 1)[0];
  }

  readU32Array(ptr, length) {
    return new Uint32Array(this.memory.buffer.slice(ptr, ptr + length * BYTE_WIDTH_I32));
  }
}
