import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_EXTENSION = '.wasm';

export async function nodeByteSource(name: string): Promise<Uint8Array> {
  const fileName = `${name}${WASM_EXTENSION}`;
  const candidates = [
    join(__dirname, fileName),
    join(__dirname, '..', fileName),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
