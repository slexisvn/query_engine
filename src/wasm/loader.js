import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { RegionAllocator } from './region-allocator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, '../../build/wasm');

const PAGE_SIZE = 65536;
const INITIAL_PAGES = 256;
const MAX_PAGES = 16384;

export class WasmLoader {
  constructor() {
    this.memory = null;
    this.instances = new Map();
    this.modules = new Map();
    this.moduleBytes = new Map();
    this.bumpOffset = 0;
    this.regionAllocator = null;
    this.shared = false;
  }

  async init(options = {}) {
    this.shared = true;

    this.memory = new WebAssembly.Memory({
      initial: INITIAL_PAGES,
      maximum: MAX_PAGES,
      shared: true,
    });
    this.bumpOffset = 0;
  }

  initRegions(regionSize) {
    if (!this.memory) throw new Error('Memory not initialized — call init() first');
    this.regionAllocator = new RegionAllocator(this.memory, regionSize);
    return this.regionAllocator;
  }

  async loadModule(name) {
    if (this.instances.has(name)) return this.instances.get(name);

    if (!this.memory) await this.init();

    const wasmPath = join(WASM_DIR, `${name}.wasm`);
    const buffer = await readFile(wasmPath);
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
    const aligned = (this.bumpOffset + 15) & ~15;
    const paddedBytes = bytes + 16;
    const newOffset = aligned + paddedBytes;
    const totalBytes = this.memory.buffer.byteLength;
    if (newOffset > totalBytes) {
      const pagesNeeded = Math.ceil((newOffset - totalBytes) / PAGE_SIZE);
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
    if (byteWidth === 4) this.writeI32Array(data, ptr);
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
    return new Int32Array(this.memory.buffer.slice(ptr, ptr + length * 4));
  }

  readF64Array(ptr, length) {
    return new Float64Array(this.memory.buffer.slice(ptr, ptr + length * 8));
  }

  readF64(ptr) {
    return new Float64Array(this.memory.buffer, ptr, 1)[0];
  }

  readU32Array(ptr, length) {
    return new Uint32Array(this.memory.buffer.slice(ptr, ptr + length * 4));
  }
}

let _globalLoader = null;

export async function getGlobalLoader(options = {}) {
  if (!_globalLoader) {
    _globalLoader = new WasmLoader();
    await _globalLoader.init(options);
  }
  return _globalLoader;
}

export function resetGlobalLoader() {
  _globalLoader = null;
}
