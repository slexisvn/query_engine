import { describe, it, expect, afterEach } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { Config } from '../../src/config.js';
import { QueryCancelledError } from '../../src/execution/pipeline.js';
import { DataType } from '../../src/storage/data-type.js';
import { NodeStorageBackend } from '../../src/storage/backend/node-storage-backend.js';
import { FsStorage } from '../../src/storage/spill-manager/fs-storage.js';
import { SpillManager } from '../../src/storage/spill-manager/spill-manager.js';

class AbortOnSpillStorage extends FsStorage {
  backend;

  constructor(basePath, backend) {
    super(basePath);
    this.backend = backend;
  }

  async append(partitionId, buffer) {
    await super.append(partitionId, buffer);
    this.backend.appendCount++;
    const abort = this.backend.abortOnAppend;
    this.backend.abortOnAppend = null;
    abort?.();
  }

  async openReader(partitionId) {
    const reader = await super.openReader(partitionId);
    if (!reader) return null;
    this.backend.readerOpenCount++;
    this.backend.activeReaders++;
    let closed = false;
    return {
      read: length => reader.read(length),
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await reader.close();
        } finally {
          this.backend.activeReaders--;
        }
      },
    };
  }
}

class TrackingNodeStorageBackend extends NodeStorageBackend {
  storages = [];
  appendCount = 0;
  abortOnAppend = null;
  readerOpenCount = 0;
  activeReaders = 0;

  createSpillManager(handle) {
    const storage = new AbortOnSpillStorage(handle, this);
    this.storages.push(storage);
    return new SpillManager(storage);
  }

  outstandingWriteHandles() {
    return this.storages.reduce((sum, storage) => sum + storage.writeHandles.size, 0);
  }
}

const saved = {
  memoryLimitBytes: Config.memoryLimitBytes,
  aggSpillPartitions: Config.aggSpillPartitions,
  aggSpillMaxRepartitionDepth: Config.aggSpillMaxRepartitionDepth,
};

afterEach(() => {
  Config.memoryLimitBytes = saved.memoryLimitBytes;
  Config.aggSpillPartitions = saved.aggSpillPartitions;
  Config.aggSpillMaxRepartitionDepth = saved.aggSpillMaxRepartitionDepth;
});

describe('cancellation cleanup for spilled operators', () => {
  it('closes aggregate spill handles before rejecting the cancelled query', async () => {
    Config.memoryLimitBytes = 96;
    Config.aggSpillPartitions = 2;
    Config.aggSpillMaxRepartitionDepth = 4;
    const backend = new TrackingNodeStorageBackend();
    const engine = createEngine({ storageBackend: backend });
    registerTable(
      engine,
      'T',
      Array.from({ length: 4000 }, (_, i) => [i, i % 101]),
      [
        { name: 'ID', dataType: DataType.INT32 },
        { name: 'V', dataType: DataType.INT32 },
      ],
    );
    const controller = new AbortController();
    backend.abortOnAppend = () => controller.abort();

    await expect(engine.run(
      'SELECT ID, COUNT(*) AS N, SUM(V) AS S FROM T GROUP BY ID',
      [],
      { signal: controller.signal },
    )).rejects.toBeInstanceOf(QueryCancelledError);

    expect(backend.appendCount).toBeGreaterThan(0);
    expect(backend.outstandingWriteHandles()).toBe(0);
    await expect(engine.run("SELECT COUNT(*) AS C FROM T WHERE V BETWEEN '10' AND '20'"))
      .resolves.toMatchObject({ rows: [{ C: 440 }] });
    engine.close();
  });

  it('closes sort spill readers when a stream is abandoned', async () => {
    Config.memoryLimitBytes = 96;
    const backend = new TrackingNodeStorageBackend();
    const engine = createEngine({ storageBackend: backend });
    registerTable(
      engine,
      'T',
      Array.from({ length: 4000 }, (_, i) => [4000 - i, i % 101]),
      [
        { name: 'ID', dataType: DataType.INT32 },
        { name: 'V', dataType: DataType.INT32 },
      ],
    );

    const result = await engine.stream('SELECT ID, V FROM T ORDER BY ID');
    for await (const _row of result) break;
    await result._sink.settled;

    expect(backend.readerOpenCount).toBeGreaterThan(0);
    expect(backend.activeReaders).toBe(0);
    expect(backend.outstandingWriteHandles()).toBe(0);
    await expect(engine.run('SELECT MIN(ID) AS LO, MAX(ID) AS HI FROM T'))
      .resolves.toMatchObject({ rows: [{ LO: 1, HI: 4000 }] });
    engine.close();
  });

  it('closes window spill readers when a stream is abandoned', async () => {
    Config.memoryLimitBytes = 96;
    const backend = new TrackingNodeStorageBackend();
    const engine = createEngine({ storageBackend: backend });
    registerTable(
      engine,
      'T',
      Array.from({ length: 4000 }, (_, i) => [i + 1, i % 101]),
      [
        { name: 'ID', dataType: DataType.INT32 },
        { name: 'V', dataType: DataType.INT32 },
      ],
    );

    const result = await engine.stream(`
      SELECT ID, ROW_NUMBER() OVER (PARTITION BY V ORDER BY ID) AS RN
      FROM T
    `);
    for await (const _row of result) break;
    await result._sink.settled;

    expect(backend.readerOpenCount).toBeGreaterThan(0);
    expect(backend.activeReaders).toBe(0);
    expect(backend.outstandingWriteHandles()).toBe(0);
    await expect(engine.run('SELECT COUNT(*) AS C FROM T'))
      .resolves.toMatchObject({ rows: [{ C: 4000 }] });
    engine.close();
  });
});
