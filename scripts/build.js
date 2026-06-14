import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdir, copyFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const NODE_ENTRY = join(SRC, 'index.js');
const BROWSER_ENTRY = join(SRC, 'browser.js');
const BUFFER_SHIM = join(__dirname, 'buffer-shim.js');

const WASM_SOURCE = join(ROOT, 'build', 'wasm', 'core.wasm');
const WASM_DIR = join(DIST, 'wasm');
const WASM_DEST = join(WASM_DIR, 'core.wasm');

const NODE_OUTFILE = join(DIST, 'bundle', 'node', 'query-engine.node.js');
const BROWSER_OUTFILE = join(DIST, 'bundle', 'browser', 'query-engine.browser.js');

const NODE_ONLY_SUBSYSTEMS = /(^|\/)(parallel|distributed)\//;

// Browser can't run the worker-thread / cluster subsystems — keep them external
// so they're tree-shaken out of the browser bundle.
const externalizeNodeSubsystemsPlugin = {
  name: 'externalize-node-subsystems',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') return null;
      if (NODE_ONLY_SUBSYSTEMS.test(args.path)) {
        return { path: args.path, external: true };
      }
      return null;
    });
  },
};

// The node entry loads wasm via a path relative to src/wasm/node-byte-source.js.
// Once bundled into dist/bundle/node/ that relative path no longer points at the
// wasm, so replace the module with a shim that reads core.wasm from dist/wasm/.
const nodeWasmShimPlugin = {
  name: 'node-wasm-shim',
  setup(build) {
    build.onLoad({ filter: /node-byte-source\.js$/ }, () => ({
      loader: 'js',
      contents: `
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
export function nodeByteSource(name) {
  return readFile(join(here, '../../wasm', name + '.wasm'));
}
`,
    }));
  },
};

const COMMON = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
  metafile: false,
};

function buildNode() {
  // Full build: everything reachable from the node entry, self-contained, with
  // wasm resolved next to the output bundle.
  return esbuild.build({
    ...COMMON,
    entryPoints: [NODE_ENTRY],
    outfile: NODE_OUTFILE,
    platform: 'node',
    plugins: [nodeWasmShimPlugin],
  });
}

function buildBrowser() {
  return esbuild.build({
    ...COMMON,
    entryPoints: [BROWSER_ENTRY],
    outfile: BROWSER_OUTFILE,
    platform: 'browser',
    define: { global: 'globalThis' },
    inject: [BUFFER_SHIM],
    plugins: [externalizeNodeSubsystemsPlugin],
  });
}

async function run() {
  const args = process.argv.slice(2);
  const only = args.includes('--node') ? 'node'
    : args.includes('--browser') ? 'browser'
    : 'both';

  await mkdir(WASM_DIR, { recursive: true });

  const tasks = [];
  if (only !== 'browser') tasks.push(buildNode());
  if (only !== 'node') tasks.push(buildBrowser());
  await Promise.all(tasks);
  await copyFile(WASM_SOURCE, WASM_DEST);

  if (only !== 'browser') console.log(`Built ${NODE_OUTFILE} (full / node)`);
  if (only !== 'node') console.log(`Built ${BROWSER_OUTFILE} (browser)`);
  console.log(`Copied ${WASM_DEST}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
