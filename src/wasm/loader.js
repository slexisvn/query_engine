import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, '../../build/wasm');

const PAGE_SIZE = 65536;
const INITIAL_PAGES = 256;

export class WasmLoader {
  constructor() {
    this.memory = null;
    this.instances = new Map();
    this.bumpOffset = 0;
  }

  async init() {
    this.memory = new WebAssembly.Memory({
      initial: INITIAL_PAGES,
      maximum: 1024,
    });
    this.bumpOffset = 0;
  }

  async loadModule(name) {
    if (this.instances.has(name)) return this.instances.get(name);

    if (!this.memory) await this.init();

    const wasmPath = join(WASM_DIR, `${name}.wasm`);
    const buffer = await readFile(wasmPath);
    const module = await WebAssembly.compile(buffer);

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

export async function getGlobalLoader() {
  if (!_globalLoader) {
    _globalLoader = new WasmLoader();
    await _globalLoader.init();
  }
  return _globalLoader;
}
