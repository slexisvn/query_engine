import { defineConfig } from 'vitest/config';

const sharedCoverage = {
  provider: 'v8',
  include: ['src/**/*.js'],
  exclude: ['src/cli/**', 'src/wasm/**', 'src/catalog/tpch-schema.js', 'src/storage/spill-manager.js', 'src/execution/physical-plan.js', 'src/optimizer/pass.js'],
  reporter: ['text', 'html'],
};

export default defineConfig({
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
