import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BufferPoolManager } from '../../src/storage/buffer-pool.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { DataType } from '../../src/storage/data-type.js';

function makeChunk(values) {
  const col = new Column(DataType.INT32, values.length);
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

describe('BufferPoolManager', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bufpool_test_'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('write and read', () => {
    it('round-trips a chunk through disk serialization', async () => {
      const pool = new BufferPoolManager(10, tmpDir);
      await pool.writePage('p0', makeChunk([10, 20, 30]));
      const restored = await pool.readPage('p0');
      expect(restored.size).toBe(3);
      expect(restored.columns[0].get(0)).toBe(10);
      expect(restored.columns[0].get(1)).toBe(20);
      expect(restored.columns[0].get(2)).toBe(30);
    });

    it('creates .qdat file on disk', async () => {
      const pool = new BufferPoolManager(10, tmpDir);
      await pool.writePage('test_page', makeChunk([1]));
      expect(fs.existsSync(path.join(tmpDir, 'test_page.qdat'))).toBe(true);
    });
  });

  describe('LRU caching', () => {
    it('returns same reference on cache hit', async () => {
      const pool = new BufferPoolManager(10, tmpDir);
      await pool.writePage('p1', makeChunk([1, 2, 3]));
      const first = await pool.fetchPage('p1');
      const second = await pool.fetchPage('p1');
      expect(first).toBe(second);
    });

    it('bypassCache reads from disk without populating cache', async () => {
      const pool = new BufferPoolManager(10, tmpDir);
      await pool.writePage('p2', makeChunk([5, 6]));
      const result = await pool.fetchPage('p2', true);
      expect(result.columns[0].get(0)).toBe(5);
      expect(pool.cache.has('p2')).toBe(false);
    });

    it('evicts LRU page when cache is full', async () => {
      const pool = new BufferPoolManager(2, tmpDir);
      await pool.writePage('a', makeChunk([1]));
      await pool.writePage('b', makeChunk([2]));
      await pool.writePage('c', makeChunk([3]));

      await pool.fetchPage('a');
      await pool.fetchPage('b');
      expect(pool.cache.has('a')).toBe(true);
      expect(pool.cache.has('b')).toBe(true);

      await pool.fetchPage('c');
      expect(pool.cache.has('c')).toBe(true);
      expect(pool.cache.has('b')).toBe(true);
      expect(pool.cache.has('a')).toBe(false);
    });

    it('accessing cached page promotes it in LRU order', async () => {
      const pool = new BufferPoolManager(2, tmpDir);
      await pool.writePage('a', makeChunk([1]));
      await pool.writePage('b', makeChunk([2]));
      await pool.writePage('c', makeChunk([3]));

      await pool.fetchPage('a');
      await pool.fetchPage('b');
      await pool.fetchPage('a');
      await pool.fetchPage('c');

      expect(pool.cache.has('a')).toBe(true);
      expect(pool.cache.has('c')).toBe(true);
      expect(pool.cache.has('b')).toBe(false);
    });
  });

  describe('clear', () => {
    it('empties cache and removes storage directory', async () => {
      const pool = new BufferPoolManager(10, tmpDir);
      await pool.writePage('p', makeChunk([1, 2]));
      await pool.fetchPage('p');
      expect(pool.cache.size).toBe(1);

      pool.clear();
      expect(pool.cache.size).toBe(0);
      expect(fs.existsSync(tmpDir)).toBe(false);
    });
  });

  describe('multiple pages', () => {
    it('reads back correct data from different pages', async () => {
      const pool = new BufferPoolManager(10, tmpDir);
      await pool.writePage('x', makeChunk([100, 200]));
      await pool.writePage('y', makeChunk([300, 400]));
      await pool.writePage('z', makeChunk([500, 600]));

      const x = await pool.fetchPage('x');
      const y = await pool.fetchPage('y');
      const z = await pool.fetchPage('z');
      expect(x.columns[0].get(0)).toBe(100);
      expect(y.columns[0].get(0)).toBe(300);
      expect(z.columns[0].get(1)).toBe(600);
    });
  });
});
