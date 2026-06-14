import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const SRC = ROOT + '/src/';
const DIST = ROOT + '/dist/js/';

const srcToDist = {
  name: 'src-to-dist',
  enforce: 'pre',
  async resolveId(id, importer, options) {
    const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
    if (resolved && !resolved.external) {
      const normalized = resolved.id.replace(/\\/g, '/');
      if (normalized.startsWith(SRC)) {
        let out = DIST + normalized.slice(SRC.length);
        if (out.endsWith('.ts')) out = out.slice(0, -3) + '.js';
        return { ...resolved, id: out };
      }
    }
    return resolved;
  },
};

const sharedCoverage = {
  provider: 'v8',
  include: ['src/**/*.{js,ts}'],
  exclude: ['src/cli/**', 'src/wasm/**', 'src/catalog/tpch-schema.js', 'src/storage/spill-manager.js', 'src/execution/physical-plan.js', 'src/optimizer/pass.js'],
  reporter: ['text', 'html'],
};

export default defineConfig({
  plugins: [srcToDist],
  test: {
    globals: true,
    coverage: {
      ...sharedCoverage,
      reportsDirectory: './coverage',
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
