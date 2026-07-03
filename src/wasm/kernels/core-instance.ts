import { getGlobalLoader } from '../loader.js';
import type { WasmLoaderLike } from '../wasm-types.js';

export interface CoreInstance {
  loader: WasmLoaderLike;
  instance: WebAssembly.Instance;
}

let _coreInstance: CoreInstance | null = null;

export async function getCoreInstance(): Promise<CoreInstance> {
  if (_coreInstance) return _coreInstance;
  const loader = await getGlobalLoader();
  _coreInstance = { loader, instance: await loader.loadModule('core') };
  return _coreInstance;
}
