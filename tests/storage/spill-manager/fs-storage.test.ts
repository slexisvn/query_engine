import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsStorage } from '../../../src/storage/spill-manager/fs-storage.js';

let baseDir;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-spill-'));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('FsStorage', () => {
  describe('existence', () => {
    it('reports an unwritten partition as absent', () => {
      expect(new FsStorage(baseDir).exists('p')).toBe(false);
    });

    it('reports a written partition as present', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1, 2, 3]));

      expect(storage.exists('p')).toBe(true);
      await storage.removeAll();
    });
  });

  describe('reader', () => {
    it('returns null for a partition that was never written', async () => {
      expect(await new FsStorage(baseDir).openReader('missing')).toBeNull();
    });

    it('reads back the bytes of a single append', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([9, 8, 7]));

      const reader = await storage.openReader('p');
      const bytes = await reader.read(3);
      await reader.close();

      expect([...bytes]).toEqual([9, 8, 7]);
    });

    it('reads appends back in order across calls', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1, 2]));
      await storage.append('p', Buffer.from([3, 4]));

      const reader = await storage.openReader('p');
      const first = await reader.read(2);
      const second = await reader.read(2);
      await reader.close();

      expect([...first]).toEqual([1, 2]);
      expect([...second]).toEqual([3, 4]);
    });

    it('returns null once the file is exhausted', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1]));

      const reader = await storage.openReader('p');
      await reader.read(1);
      const past = await reader.read(1);
      await reader.close();

      expect(past).toBeNull();
    });

    it('returns null when asked for more bytes than the file holds', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1, 2]));

      const reader = await storage.openReader('p');
      const overshoot = await reader.read(16);
      await reader.close();

      expect(overshoot).toBeNull();
    });

    it('serves two independent readers over the same partition', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1, 2, 3, 4]));

      const first = await storage.openReader('p');
      const second = await storage.openReader('p');
      const firstHead = await first.read(2);
      const secondHead = await second.read(2);
      await first.close();
      await second.close();

      expect([...firstHead]).toEqual([1, 2]);
      expect([...secondHead]).toEqual([1, 2]);
    });
  });

  describe('write handles', () => {
    it('reuses one handle across many appends', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1]));
      await storage.append('p', Buffer.from([2]));

      expect(storage.writeHandles.size).toBe(1);
      await storage.removeAll();
    });

    it('closes the write handle when a reader is opened', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1]));

      const reader = await storage.openReader('p');
      await reader.close();

      expect(storage.writeHandles.has('p')).toBe(false);
    });

    it('keeps handles for other partitions open when one is read', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1]));
      await storage.append('q', Buffer.from([2]));

      const reader = await storage.openReader('p');
      await reader.close();

      expect(storage.writeHandles.has('q')).toBe(true);
      await storage.removeAll();
    });

    it('allows appending again after a read closed the handle', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1]));
      const reader = await storage.openReader('p');
      await reader.close();

      await storage.append('p', Buffer.from([2]));

      const second = await storage.openReader('p');
      const bytes = await second.read(2);
      await second.close();

      expect([...bytes]).toEqual([1, 2]);
    });
  });

  describe('clearing', () => {
    it('removes the file for a single partition', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1]));
      await storage.append('q', Buffer.from([2]));

      await storage.remove('p');

      expect(storage.exists('p')).toBe(false);
      expect(storage.exists('q')).toBe(true);
      await storage.removeAll();
    });

    it('removes every spilled partition', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1]));
      await storage.append('q', Buffer.from([2]));

      await storage.removeAll();

      expect(storage.exists('p')).toBe(false);
      expect(storage.exists('q')).toBe(false);
    });

    it('stays usable for new spills after removeAll', async () => {
      const storage = new FsStorage(baseDir);
      await storage.append('p', Buffer.from([1]));
      await storage.removeAll();

      await storage.append('p', Buffer.from([2]));

      expect(storage.exists('p')).toBe(true);
      await storage.removeAll();
    });

    it('cleans up after an append that could not open its file', async () => {
      const storage = new FsStorage(path.join(baseDir, 'not-created-yet'));
      await expect(storage.append('p', Buffer.from([1]))).rejects.toThrow();

      await expect(storage.removeAll()).resolves.toBeUndefined();
    });

    it('recovers once the directory an append needed exists', async () => {
      const dir = path.join(baseDir, 'created-late');
      const storage = new FsStorage(dir);
      await expect(storage.append('p', Buffer.from([1]))).rejects.toThrow();

      fs.mkdirSync(dir, { recursive: true });

      await expect(storage.append('p', Buffer.from([1]))).resolves.toBeUndefined();
      expect(storage.exists('p')).toBe(true);
      await storage.removeAll();
    });

    it('tolerates removing a partition that does not exist', async () => {
      const storage = new FsStorage(baseDir);
      await expect(storage.remove('missing')).resolves.toBeUndefined();
    });
  });
});
