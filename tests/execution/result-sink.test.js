import { describe, it, expect } from 'vitest';
import { ResultSink } from '../../src/execution/result-sink.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';

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

      expect(sink.chunks.length).toBe(2);
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

      expect(sink.chunks.length).toBe(2);
      expect(sink.totalRows).toBe(2);
    });

    it('skips null chunks', async () => {
      const sink = new ResultSink(false);
      await sink.init();
      await sink.consume(null);

      expect(sink.chunks.length).toBe(0);
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
