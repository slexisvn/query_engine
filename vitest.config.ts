import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join('/');
const SRC = `${ROOT}/src/`;
const DIST = `${ROOT}/dist/`;

interface ResolvedId {
  id: string;
  external: boolean | string;
}

interface ResolverContext {
  resolve(id: string, importer: string | undefined, options: Record<string, unknown>): Promise<ResolvedId | null>;
}

const srcToDist = {
  name: 'src-to-dist',
  enforce: 'pre' as const,
  async resolveId(this: ResolverContext, id: string, importer: string | undefined, options: Record<string, unknown>) {
    const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
    if (!resolved || resolved.external) return resolved;

    const normalized = resolved.id.split(path.sep).join('/');
    if (!normalized.startsWith(SRC)) return resolved;

    const relative = normalized.slice(SRC.length);
    const compiled = relative.endsWith('.ts') ? `${relative.slice(0, -3)}.js` : relative;
    return { ...resolved, id: DIST + compiled };
  },
};

const coverage = {
  provider: 'v8' as const,
  include: ['src/**/*.{js,ts}'],
  exclude: ['src/cli/**', 'src/wasm/**', 'src/catalog/tpch-schema.js'],
  reporter: ['text', 'html'],
  reportsDirectory: './coverage',
  thresholds: {
    statements: 90,
    branches: 90,
    functions: 90,
    lines: 90,
  },
};

export default defineConfig({
  plugins: [srcToDist],
  test: {
    globals: true,
    coverage,
    projects: [
      {
        plugins: [srcToDist],
        test: {
          name: 'unit',
          globals: true,
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/e2e/**', 'tests/**/e2e/**'],
        },
      },
      {
        plugins: [srcToDist],
        test: {
          name: 'e2e',
          globals: true,
          include: ['tests/e2e/**/*.test.ts', 'tests/**/e2e/**/*.test.ts'],
          testTimeout: 60000,
        },
      },
    ],
  },
});
