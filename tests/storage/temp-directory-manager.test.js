import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TempDirectoryManager } from '../../src/storage/temp-space/temp-directory-manager.js';

describe('TempDirectoryManager', () => {
  const managers = [];

  afterEach(() => {
    for (const m of managers) m.cleanup();
    managers.length = 0;
  });

  function create(opts) {
    const m = new TempDirectoryManager(opts);
    managers.push(m);
    return m;
  }

  describe('allocate', () => {
    it('creates real directories on disk', () => {
      const m = create();
      const dir = m.allocate('sort', 'run');
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    });

    it('increments sequence number per category', () => {
      const m = create();
      const d0 = m.allocate('hash', 'part');
      const d1 = m.allocate('hash', 'part');
      const d2 = m.allocate('hash', 'part');
      expect(d0).toContain('part_0');
      expect(d1).toContain('part_1');
      expect(d2).toContain('part_2');
      expect(fs.existsSync(d0)).toBe(true);
      expect(fs.existsSync(d2)).toBe(true);
    });

    it('tracks independent sequences per category', () => {
      const m = create();
      const s0 = m.allocate('sort', 'run');
      const h0 = m.allocate('hash', 'bucket');
      const s1 = m.allocate('sort', 'run');
      const h1 = m.allocate('hash', 'bucket');
      expect(s0).toContain('run_0');
      expect(s1).toContain('run_1');
      expect(h0).toContain('bucket_0');
      expect(h1).toContain('bucket_1');
    });

    it('organizes directories under category subdirectory', () => {
      const m = create();
      const dir = m.allocate('sort', 'run');
      const parts = dir.split(path.sep);
      expect(parts).toContain('sort');
    });
  });

  describe('cleanup', () => {
    it('removes entire root directory tree', () => {
      const m = create();
      m.allocate('cat1', 'item');
      m.allocate('cat2', 'item');
      const root = m.getRootDir();
      expect(fs.existsSync(root)).toBe(true);
      m.cleanup();
      expect(fs.existsSync(root)).toBe(false);
    });

    it('is safe to call multiple times', () => {
      const m = create();
      m.allocate('x', 'y');
      m.cleanup();
      expect(() => m.cleanup()).not.toThrow();
    });

    it('allows re-allocation after cleanup', () => {
      const m = create();
      m.allocate('a', 'b');
      m.cleanup();
      const dir = m.allocate('c', 'd');
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe('custom baseDir', () => {
    it('allocates directories under custom base', () => {
      const customBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tdm_custom_'));
      try {
        const m = create({ baseDir: customBase });
        const dir = m.allocate('test', 'dir');
        expect(dir.startsWith(customBase)).toBe(true);
        expect(fs.existsSync(dir)).toBe(true);
      } finally {
        fs.rmSync(customBase, { recursive: true, force: true });
      }
    });
  });

  describe('isolation between managers', () => {
    it('two managers have separate root directories', () => {
      const m1 = create();
      const m2 = create();
      const d1 = m1.allocate('x', 'y');
      const d2 = m2.allocate('x', 'y');
      expect(m1.getRootDir()).not.toBe(m2.getRootDir());
      expect(d1).not.toBe(d2);
    });

    it('cleaning one manager does not affect the other', () => {
      const m1 = create();
      const m2 = create();
      const d1 = m1.allocate('a', 'b');
      const d2 = m2.allocate('a', 'b');
      m1.cleanup();
      expect(fs.existsSync(d1)).toBe(false);
      expect(fs.existsSync(d2)).toBe(true);
    });
  });
});
