import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdir, copyFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const NODE_ENTRY = join(SRC, 'index.ts');
const BROWSER_ENTRY = join(SRC, 'browser.ts');
const BUFFER_SHIM = join(__dirname, 'buffer-shim.js');

const NODE_OUTFILE = join(DIST, 'bundle', 'node', 'query-engine.node.js');
const BROWSER_OUTFILE = join(DIST, 'bundle', 'browser', 'query-engine.browser.js');

const NODE_ONLY_SUBSYSTEMS = /(^|\/)(parallel|distributed)\//;

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

  const tasks = [];
  if (only !== 'browser') tasks.push(buildNode());
  if (only !== 'node') tasks.push(buildBrowser());
  await Promise.all(tasks);

  if (only !== 'browser') console.log(`Built ${NODE_OUTFILE} (full / node)`);
  if (only !== 'node') console.log(`Built ${BROWSER_OUTFILE} (browser)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
