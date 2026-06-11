const WASM_EXTENSION = '.wasm';

let _baseUrl = null;

export function setWasmBaseUrl(url) {
  _baseUrl = url;
}

function resolveWasmUrl(name) {
  const fileName = `${name}${WASM_EXTENSION}`;
  if (_baseUrl) return new URL(fileName, _baseUrl).href;
  return new URL(fileName, import.meta.url).href;
}

export async function fetchByteSource(name) {
  const response = await fetch(resolveWasmUrl(name));
  if (!response.ok) {
    throw new Error(`Failed to fetch wasm module '${name}': ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
