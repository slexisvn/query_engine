import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';

async function readAll(reader, sizes) {
  const parts = [];
  for (const size of sizes) parts.push(await reader.read(size));
  return parts;
}

describe('MemoryStorage', () => {
  describe('existence', () => {
    it('reports an unwritten partition as absent', () => {
      expect(new MemoryStorage().exists('p')).toBe(false);
    });

    it('reports a written partition as present', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1, 2, 3]));

      expect(storage.exists('p')).toBe(true);
    });

    it('reports a removed partition as absent again', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1]));
      await storage.remove('p');

      expect(storage.exists('p')).toBe(false);
    });
  });

  describe('reader', () => {
    it('returns null for a partition that was never written', async () => {
      expect(await new MemoryStorage().openReader('missing')).toBeNull();
    });

    it('returns the bytes of a single append', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1, 2, 3, 4]));

      const reader = await storage.openReader('p');

      expect([...(await reader.read(4))]).toEqual([1, 2, 3, 4]);
    });

    it('advances the cursor across successive reads', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1, 2, 3, 4, 5, 6]));

      const reader = await storage.openReader('p');
      const [first, second] = await readAll(reader, [2, 3]);

      expect([...first]).toEqual([1, 2]);
      expect([...second]).toEqual([3, 4, 5]);
    });

    it('stitches a read that spans two appended buffers', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1, 2]));
      await storage.append('p', Buffer.from([3, 4]));

      const reader = await storage.openReader('p');

      expect([...(await reader.read(4))]).toEqual([1, 2, 3, 4]);
    });

    it('stitches a read that spans many appended buffers', async () => {
      const storage = new MemoryStorage();
      for (let i = 0; i < 8; i++) await storage.append('p', Buffer.from([i]));

      const reader = await storage.openReader('p');

      expect([...(await reader.read(8))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('returns null once the stream is exhausted', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1, 2]));

      const reader = await storage.openReader('p');
      await reader.read(2);

      expect(await reader.read(1)).toBeNull();
    });

    it('returns null when asked for more bytes than remain', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1, 2]));

      const reader = await storage.openReader('p');

      expect(await reader.read(5)).toBeNull();
    });

    it('returns an empty buffer for a zero-length read', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1]));

      const reader = await storage.openReader('p');

      expect((await reader.read(0)).length).toBe(0);
    });

    it('copies appended buffers so later mutation of the source is not observed', async () => {
      const storage = new MemoryStorage();
      const source = Buffer.from([1, 2, 3]);
      await storage.append('p', source);
      source[0] = 99;

      const reader = await storage.openReader('p');

      expect([...(await reader.read(3))]).toEqual([1, 2, 3]);
    });
  });

  describe('clearing', () => {
    it('drops only the named partition', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1]));
      await storage.append('q', Buffer.from([2]));

      await storage.remove('p');

      expect(storage.exists('p')).toBe(false);
      expect(storage.exists('q')).toBe(true);
    });

    it('drops every partition', async () => {
      const storage = new MemoryStorage();
      await storage.append('p', Buffer.from([1]));
      await storage.append('q', Buffer.from([2]));

      await storage.removeAll();

      expect(storage.exists('p')).toBe(false);
      expect(storage.exists('q')).toBe(false);
    });
  });
});
