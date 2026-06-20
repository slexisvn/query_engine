import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, '../../wasm');
const WASM_EXTENSION = '.wasm';

export function nodeByteSource(name: string): Promise<Uint8Array> {
  return readFile(join(WASM_DIR, `${name}${WASM_EXTENSION}`));
}
