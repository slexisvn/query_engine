const WASM_EXTENSION = '.wasm';

let _baseUrl: string | URL | null = null;

export function setWasmBaseUrl(url: string | URL | null): void {
  _baseUrl = url;
}

function resolveWasmUrl(name: string): string {
  const fileName = `${name}${WASM_EXTENSION}`;
  if (_baseUrl) return new URL(fileName, _baseUrl).href;
  return new URL(fileName, import.meta.url).href;
}

export async function fetchByteSource(name: string): Promise<Uint8Array> {
  const response = await fetch(resolveWasmUrl(name));
  if (!response.ok) {
    throw new Error(`Failed to fetch wasm module '${name}': ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
