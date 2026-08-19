import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResultSink } from '../../src/execution/result-sink.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { DataType } from '../../src/storage/data-type.js';
import { SpillManager } from '../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../src/storage/spill-manager/memory-storage.js';
import { captureMemoryLimit, limitResidentRows } from '../helpers/memory-limits.js';

function makeChunk(values) {
  const col = new Column('INT32', values.length);
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

describe('ResultSink', () => {
  describe('batch mode (non-streaming)', () => {
    it('collects chunks via consume', async () => {
      const sink = new ResultSink(false);
      await sink.init();
      await sink.consume(makeChunk([1, 2]));
      await sink.consume(makeChunk([3, 4]));

      expect(sink.residentChunks.length).toBe(2);
      expect(sink.totalRows).toBe(4);
    });

    it('iterates collected chunks via asyncIterator', async () => {
      const sink = new ResultSink(false);
      await sink.init();
      await sink.consume(makeChunk([10, 20]));
      await sink.consume(makeChunk([30]));
      await sink.finalize();

      const collected = [];
      for await (const chunk of sink) {
        collected.push(chunk);
      }

      expect(collected.length).toBe(2);
      expect(collected[0].size).toBe(2);
      expect(collected[1].size).toBe(1);
    });

    it('collect() returns all chunks as array', async () => {
      const sink = new ResultSink(false);
      await sink.init();
      await sink.consume(makeChunk([1]));
      await sink.consume(makeChunk([2]));
      await sink.finalize();

      const chunks = await sink.collect();

      expect(chunks.length).toBe(2);
    });

    it('skips empty chunks', async () => {
      const sink = new ResultSink(false);
      await sink.init();
      await sink.consume(makeChunk([1]));
      await sink.consume(new DataChunk([], 0));
      await sink.consume(makeChunk([2]));

      expect(sink.residentChunks.length).toBe(2);
      expect(sink.totalRows).toBe(2);
    });

    it('skips null chunks', async () => {
      const sink = new ResultSink(false);
      await sink.init();
      await sink.consume(null);

      expect(sink.residentChunks.length).toBe(0);
    });
  });

  describe('streaming mode', () => {
    it('produces chunks via async iterator as they arrive', async () => {
      const sink = new ResultSink(true);
      await sink.init();

      const consumePromise = (async () => {
        await sink.consume(makeChunk([1, 2]));
        await sink.consume(makeChunk([3, 4]));
        await sink.finalize();
      })();

      const chunks = [];
      for await (const chunk of sink) {
        chunks.push(chunk);
      }

      await consumePromise;
      expect(chunks.length).toBe(2);
      expect(sink.totalRows).toBe(4);
    });

    it('iterator stops after finalize', async () => {
      const sink = new ResultSink(true);
      await sink.init();

      setTimeout(async () => {
        await sink.consume(makeChunk([10]));
        await sink.finalize();
      }, 5);

      const chunks = await sink.collect();

      expect(chunks.length).toBe(1);
    });
  });

  describe('error handling', () => {
    it('error() makes streaming iterator throw', async () => {
      const sink = new ResultSink(true);
      await sink.init();

      setTimeout(() => {
        sink.error(new Error('pipeline failure'));
      }, 5);

      const chunks = [];
      let caught = null;
      try {
        for await (const chunk of sink) {
          chunks.push(chunk);
        }
      } catch (e) {
        caught = e;
      }

      expect(caught).not.toBeNull();
      expect(caught.message).toBe('pipeline failure');
    });

    it('consume after error throws', async () => {
      const sink = new ResultSink(false);
      await sink.init();
      sink.error(new Error('broken'));

      await expect(sink.consume(makeChunk([1]))).rejects.toThrow('broken');
    });
  });

  describe('totalRows tracking', () => {
    it('accumulates row count across chunks', async () => {
      const sink = new ResultSink(false);
      await sink.init();
      await sink.consume(makeChunk([1, 2, 3]));
      await sink.consume(makeChunk([4, 5]));

      expect(sink.totalRows).toBe(5);
    });
  });
});

describe('ResultSink materialized spilling', () => {
  const ROW_SCHEMA = [DataType.INT32];
  let restoreMemoryLimit;

  beforeEach(() => { restoreMemoryLimit = captureMemoryLimit(); });
  afterEach(() => { restoreMemoryLimit(); });

  function memSpill() {
    return new SpillManager(new MemoryStorage());
  }

  async function feed(sink, chunkCount, rowsPerChunk) {
    for (let c = 0; c < chunkCount; c++) {
      await sink.consume(makeChunk(Array.from({ length: rowsPerChunk }, (_, i) => c * rowsPerChunk + i)));
    }
    await sink.finalize();
  }

  async function drain(sink) {
    const values = [];
    for await (const chunk of sink) {
      for (let i = 0; i < chunk.size; i++) values.push(chunk.getValue(i, 0));
    }
    return values;
  }

  it('keeps everything in memory when the budget is not exceeded', async () => {
    const sink = new ResultSink(false, memSpill());
    await feed(sink, 3, 4);

    expect(sink.spilledChunkCount).toBe(0);
  });

  it('spills once the accumulated result exceeds the budget', async () => {
    limitResidentRows(ROW_SCHEMA, 8);
    const sink = new ResultSink(false, memSpill());
    await feed(sink, 20, 4);

    expect(sink.spilledChunkCount).toBeGreaterThan(0);
  });

  it('never spills when no spill store is injected', async () => {
    limitResidentRows(ROW_SCHEMA, 2);
    const sink = new ResultSink(false, null);
    await feed(sink, 20, 4);

    expect(sink.spilledChunkCount).toBe(0);
  });

  it('returns every row in order after spilling', async () => {
    limitResidentRows(ROW_SCHEMA, 8);
    const sink = new ResultSink(false, memSpill());
    await feed(sink, 25, 4);

    expect(await drain(sink)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('returns the same rows spilled as unspilled', async () => {
    const unspilled = new ResultSink(false, memSpill());
    await feed(unspilled, 12, 5);
    const expected = await drain(unspilled);

    limitResidentRows(ROW_SCHEMA, 6);
    const spilled = new ResultSink(false, memSpill());
    await feed(spilled, 12, 5);

    expect(await drain(spilled)).toEqual(expected);
  });

  it('bounds resident chunks while consuming far more than the budget', async () => {
    limitResidentRows(ROW_SCHEMA, 8);
    const sink = new ResultSink(false, memSpill());
    let peak = 0;

    for (let c = 0; c < 30; c++) {
      await sink.consume(makeChunk(Array.from({ length: 4 }, (_, i) => c * 4 + i)));
      peak = Math.max(peak, sink.residentChunks.length);
    }

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('reports only the still-resident chunks, leaving the spilled ones to the drain', async () => {
    limitResidentRows(ROW_SCHEMA, 8);
    const sink = new ResultSink(false, memSpill());
    await feed(sink, 20, 5);

    const residentRows = sink.residentChunks.reduce((sum, chunk) => sum + chunk.size, 0);

    expect(sink.spilledChunkCount).toBeGreaterThan(0);
    expect(residentRows).toBeLessThan(sink.totalRows);
    expect((await drain(sink)).length).toBe(sink.totalRows);
  });

  it('still reports the full row count after spilling', async () => {
    limitResidentRows(ROW_SCHEMA, 8);
    const sink = new ResultSink(false, memSpill());
    await feed(sink, 20, 5);

    expect(sink.totalRows).toBe(100);
  });

  it('spills each chunk once when two producers feed the sink at the same time', async () => {
    limitResidentRows(ROW_SCHEMA, 4);
    const sink = new ResultSink(false, memSpill());

    await Promise.all([
      (async () => { for (let c = 0; c < 6; c++) await sink.consume(makeChunk([c * 2, c * 2 + 1])); })(),
      (async () => { for (let c = 6; c < 12; c++) await sink.consume(makeChunk([c * 2, c * 2 + 1])); })(),
    ]);
    await sink.finalize();

    const drained = await drain(sink);
    expect(drained.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it('releases the spill store once drained', async () => {
    limitResidentRows(ROW_SCHEMA, 8);
    const spill = memSpill();
    const sink = new ResultSink(false, spill);
    await feed(sink, 20, 4);
    await drain(sink);

    expect(spill.storage.store.size).toBe(0);
  });
});
