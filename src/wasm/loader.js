import { WasmLoaderBase, INITIAL_PAGES, MAX_PAGES } from './wasm-loader-base.js';

export class WasmLoader extends WasmLoaderBase {
  constructor(byteSource) {
    super();
    this.byteSource = byteSource;
  }

  async init(_options = {}) {
    this.shared = true;
    this.memory = new WebAssembly.Memory({
      initial: INITIAL_PAGES,
      maximum: MAX_PAGES,
      shared: true,
    });
    this.bumpOffset = 0;
  }

  async fetchModuleBytes(name) {
    return this.byteSource(name);
  }
}

let _globalLoader = null;
let _byteSource = null;

export function configureWasmSource(byteSource) {
  _byteSource = byteSource;
}

export async function getGlobalLoader(options = {}) {
  if (!_globalLoader) {
    if (!_byteSource) {
      throw new Error('WASM byte source not configured — call configureWasmSource() first');
    }
    _globalLoader = new WasmLoader(_byteSource);
    await _globalLoader.init(options);
  }
  return _globalLoader;
}

export function resetGlobalLoader() {
  _globalLoader = null;
}
