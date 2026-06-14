import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdir, copyFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WASM_SOURCE = join(ROOT, 'build', 'wasm', 'core.wasm');
const WASM_DIR = join(ROOT, 'dist', 'wasm');
const WASM_DEST = join(WASM_DIR, 'core.wasm');

await mkdir(WASM_DIR, { recursive: true });
await copyFile(WASM_SOURCE, WASM_DEST);
console.log(`Copied ${WASM_DEST}`);
