import { describe, it, expect } from 'vitest';
import { SpillManager } from '../../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DataType } from '../../../src/storage/data-type.js';

function makeChunk(values) {
  const col = new Column(DataType.INT32, Math.max(values.length, 1));
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

function chunkValues(chunk) {
  const out = [];
  for (let i = 0; i < chunk.size; i++) out.push(chunk.getValue(i, 0));
  return out;
}

class ReadRecordingStorage {
  constructor() {
    this.inner = new MemoryStorage();
    this.readLengths = [];
    this.openedReaders = 0;
    this.closedReaders = 0;
  }

  append(partitionId, buffer) {
    return this.inner.append(partitionId, buffer);
  }

  async openReader(partitionId) {
    const reader = await this.inner.openReader(partitionId);
    if (!reader) return null;
    this.openedReaders++;
    const owner = this;
    return {
      async read(length) {
        owner.readLengths.push(length);
        return reader.read(length);
      },
      async close() {
        owner.closedReaders++;
        return reader.close();
      },
    };
  }

  exists(partitionId) {
    return this.inner.exists(partitionId);
  }

  remove(partitionId) {
    return this.inner.remove(partitionId);
  }

  removeAll() {
    return this.inner.removeAll();
  }

  get totalBytesRead() {
    return this.readLengths.reduce((sum, n) => sum + n, 0);
  }

  get storedBytes() {
    let total = 0;
    for (const buffers of this.inner.store.values()) {
      for (const buffer of buffers) total += buffer.length;
    }
    return total;
  }
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('SpillManager', () => {
  describe('round-trip fidelity', () => {
    it('reads back a single chunk unchanged', async () => {
      const manager = new SpillManager(new MemoryStorage());
      await manager.appendChunk('p', makeChunk([1, 2, 3]));

      const chunks = await collect(manager.readChunks('p'));

      expect(chunks).toHaveLength(1);
      expect(chunkValues(chunks[0])).toEqual([1, 2, 3]);
    });

    it('reads back many chunks in append order', async () => {
      const manager = new SpillManager(new MemoryStorage());
      for (let i = 0; i < 25; i++) await manager.appendChunk('p', makeChunk([i, i + 1]));

      const chunks = await collect(manager.readChunks('p'));

      expect(chunks).toHaveLength(25);
      expect(chunks.map(c => chunkValues(c)[0])).toEqual(Array.from({ length: 25 }, (_, i) => i));
    });

    it('keeps partitions isolated from one another', async () => {
      const manager = new SpillManager(new MemoryStorage());
      await manager.appendChunk('left', makeChunk([1]));
      await manager.appendChunk('right', makeChunk([9]));

      expect(chunkValues((await collect(manager.readChunks('left')))[0])).toEqual([1]);
      expect(chunkValues((await collect(manager.readChunks('right')))[0])).toEqual([9]);
    });
  });

  describe('empty and missing partitions', () => {
    it('yields nothing for a partition that was never written', async () => {
      const manager = new SpillManager(new MemoryStorage());
      expect(await collect(manager.readChunks('absent'))).toEqual([]);
    });

    it('skips writing an empty chunk', async () => {
      const manager = new SpillManager(new MemoryStorage());
      await manager.appendChunk('p', makeChunk([]));

      expect(manager.hasSpilled('p')).toBe(false);
      expect(await collect(manager.readChunks('p'))).toEqual([]);
    });

    it('skips writing a null chunk', async () => {
      const manager = new SpillManager(new MemoryStorage());
      await manager.appendChunk('p', null);

      expect(manager.hasSpilled('p')).toBe(false);
    });

    it('reports a partition as spilled once a non-empty chunk lands', async () => {
      const manager = new SpillManager(new MemoryStorage());
      await manager.appendChunk('p', makeChunk([7]));

      expect(manager.hasSpilled('p')).toBe(true);
    });
  });

  describe('bounded reads', () => {
    it('never issues a read larger than one framed chunk', async () => {
      const storage = new ReadRecordingStorage();
      const manager = new SpillManager(storage);
      for (let i = 0; i < 40; i++) await manager.appendChunk('p', makeChunk([i]));

      await collect(manager.readChunks('p'));

      const frames = storage.inner.store.get('p');
      const largestFrame = Math.max(...frames.map(b => b.length));
      expect(Math.max(...storage.readLengths)).toBeLessThan(largestFrame);
    });

    it('reads only the consumed prefix when iteration stops early', async () => {
      const storage = new ReadRecordingStorage();
      const manager = new SpillManager(storage);
      for (let i = 0; i < 50; i++) await manager.appendChunk('p', makeChunk([i]));

      for await (const chunk of manager.readChunks('p')) {
        expect(chunkValues(chunk)).toEqual([0]);
        break;
      }

      expect(storage.totalBytesRead).toBeLessThan(storage.storedBytes / 10);
    });

    it('closes the reader when iteration stops early', async () => {
      const storage = new ReadRecordingStorage();
      const manager = new SpillManager(storage);
      for (let i = 0; i < 10; i++) await manager.appendChunk('p', makeChunk([i]));

      for await (const chunk of manager.readChunks('p')) {
        expect(chunk.size).toBe(1);
        break;
      }

      expect(storage.openedReaders).toBe(1);
      expect(storage.closedReaders).toBe(1);
    });

    it('closes the reader after a full drain', async () => {
      const storage = new ReadRecordingStorage();
      const manager = new SpillManager(storage);
      await manager.appendChunk('p', makeChunk([1]));

      await collect(manager.readChunks('p'));

      expect(storage.closedReaders).toBe(1);
    });

    it('keeps concurrent readers of the same partition independent', async () => {
      const manager = new SpillManager(new MemoryStorage());
      for (let i = 0; i < 5; i++) await manager.appendChunk('p', makeChunk([i]));

      const first = manager.readChunks('p');
      const second = manager.readChunks('p');

      const firstHead = await first.next();
      const secondHead = await second.next();

      expect(chunkValues(firstHead.value)).toEqual([0]);
      expect(chunkValues(secondHead.value)).toEqual([0]);

      await first.return();
      await second.return();
    });
  });

  describe('clearing', () => {
    it('drops a single partition', async () => {
      const manager = new SpillManager(new MemoryStorage());
      await manager.appendChunk('p', makeChunk([1]));
      await manager.appendChunk('q', makeChunk([2]));

      await manager.clearPartition('p');

      expect(manager.hasSpilled('p')).toBe(false);
      expect(manager.hasSpilled('q')).toBe(true);
    });

    it('drops every partition', async () => {
      const manager = new SpillManager(new MemoryStorage());
      await manager.appendChunk('p', makeChunk([1]));
      await manager.appendChunk('q', makeChunk([2]));

      await manager.clearAll();

      expect(manager.hasSpilled('p')).toBe(false);
      expect(manager.hasSpilled('q')).toBe(false);
    });
  });
});
