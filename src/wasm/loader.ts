import { WasmLoaderBase, INITIAL_PAGES, MAX_PAGES } from './wasm-loader-base.js';
import type { ByteSource } from './wasm-types.js';

export interface WasmLoaderInitOptions {
  shared?: boolean;
}

export class WasmLoader extends WasmLoaderBase {
  declare byteSource: ByteSource;
  declare memory: WebAssembly.Memory | null;
  declare shared: boolean;
  declare bumpOffset: number;

  constructor(byteSource: ByteSource) {
    super();
    this.byteSource = byteSource;
  }

  async init(_options: WasmLoaderInitOptions = {}): Promise<void> {
    this.shared = true;
    this.memory = new WebAssembly.Memory({
      initial: INITIAL_PAGES,
      maximum: MAX_PAGES,
      shared: true,
    });
    this.bumpOffset = 0;
  }

  override async fetchModuleBytes(name: string): Promise<Uint8Array> {
    return this.byteSource(name);
  }
}

let _globalLoader: WasmLoader | null = null;
let _byteSource: ByteSource | null = null;

export function configureWasmSource(byteSource: ByteSource): void {
  _byteSource = byteSource;
}

export async function getGlobalLoader(options: WasmLoaderInitOptions = {}): Promise<WasmLoader> {
  if (!_globalLoader) {
    if (!_byteSource) {
      throw new Error('WASM byte source not configured — call configureWasmSource() first');
    }
    _globalLoader = new WasmLoader(_byteSource);
    await _globalLoader.init(options);
  }
  return _globalLoader;
}

export function resetGlobalLoader(): void {
  _globalLoader = null;
}
