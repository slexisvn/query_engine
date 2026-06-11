import esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdir, copyFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const ENTRY = join(SRC, 'browser.js');
const BUFFER_SHIM = join(__dirname, 'buffer-shim.js');
const OUTFILE = join(DIST, 'query-engine.browser.js');
const WASM_SOURCE = join(ROOT, 'build', 'wasm', 'core.wasm');
const WASM_DEST = join(DIST, 'core.wasm');

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

async function run() {
  await mkdir(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    legalComments: 'none',
    metafile: false,
    define: { global: 'globalThis' },
    inject: [BUFFER_SHIM],
    plugins: [externalizeNodeSubsystemsPlugin],
  });

  await copyFile(WASM_SOURCE, WASM_DEST);

  console.log(`Built ${OUTFILE}`);
  console.log(`Copied ${WASM_DEST}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
