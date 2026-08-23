import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(HERE, '../..');
const ENGINE_SRC = resolve(ENGINE_ROOT, 'src');
const ENGINE_ALIAS = '@engine/';
const NODE_ONLY_SUBSYSTEMS = /(^|\/)(parallel|distributed)\//;
const NODE_ONLY_STUB = '\0node-only-stub';

function posix(path: string): string {
  return path.split(sep).join('/');
}

function typeScriptSource(jsPath: string): string | null {
  const candidate = jsPath.endsWith('.js') ? `${jsPath.slice(0, -3)}.ts` : `${jsPath}.ts`;
  return existsSync(candidate) ? candidate : null;
}

function isNodeOnly(target: string): boolean {
  const normalized = posix(target);
  return normalized.startsWith(posix(ENGINE_SRC)) && NODE_ONLY_SUBSYSTEMS.test(normalized);
}

const resolveEngineSource = {
  name: 'resolve-engine-source',
  enforce: 'pre' as const,
  resolveId(id: string, importer: string | undefined) {
    if (id === NODE_ONLY_STUB) return id;

    if (id.startsWith(ENGINE_ALIAS)) {
      const target = resolve(ENGINE_SRC, id.slice(ENGINE_ALIAS.length));
      if (isNodeOnly(target)) return NODE_ONLY_STUB;
      return typeScriptSource(target) ?? target;
    }

    if (!importer || !id.startsWith('.') || !id.endsWith('.js')) return null;
    const target = resolve(dirname(importer), id);
    if (isNodeOnly(target)) return NODE_ONLY_STUB;
    return typeScriptSource(target);
  },

  load(id: string) {
    if (id !== NODE_ONLY_STUB) return null;
    return 'throw new Error("parallel and distributed execution are node-only; the visualizer runs single-threaded in the browser");';
  },
};

export default defineConfig({
  base: process.env.VIZ_BASE ?? '/',
  plugins: [resolveEngineSource, react()],
  server: { port: Number(process.env.PORT) || 5173, fs: { allow: [ENGINE_ROOT] } },
});
