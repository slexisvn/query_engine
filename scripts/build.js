import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { rmSync } from 'fs';
import { chmod } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const NODE_ENTRY = join(SRC, 'index.ts');
const BROWSER_ENTRY = join(SRC, 'browser.ts');
const BUFFER_SHIM = join(__dirname, 'buffer-shim.js');

const NODE_OUTFILE = join(DIST, 'index.node.js');
const BROWSER_OUTFILE = join(DIST, 'index.browser.js');
const CLI_OUTFILE = join(DIST, 'index.cli.js');

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
  const fileName = name + '.wasm';
  return readFile(join(here, fileName)).catch(() => readFile(join(here, '..', fileName)));
}
`,
    }));
  },
};

const cliNodeEntryPlugin = {
  name: 'cli-node-entry',
  setup(build) {
    build.onResolve({ filter: /^(\.\.\/|\.\.\/\.\.\/)index\.js$/ }, (args) => {
      if (args.importer.replace(/\\/g, '/').includes('/src/cli/')) {
        return { path: './index.node.js', external: true };
      }
      return null;
    });
  },
};

const COMMON = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
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

function buildCli() {
  return esbuild.build({
    ...COMMON,
    stdin: {
      contents: `
import { start } from '../src/cli/index.ts';
start();
`,
      resolveDir: DIST,
      sourcefile: 'cli-entry.js',
      loader: 'js',
    },
    outfile: CLI_OUTFILE,
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    external: ['./index.node.js', 'cli-highlight', 'csv-parser'],
    plugins: [cliNodeEntryPlugin],
  });
}

async function run() {
  rmSync(DIST, { recursive: true, force: true });
  await Promise.all([buildNode(), buildBrowser()]);
  await buildCli();
  await chmod(CLI_OUTFILE, 0o755);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
