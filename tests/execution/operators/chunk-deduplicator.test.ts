import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChunkDeduplicator } from '../../../src/execution/operators/chunk-deduplicator.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DictionaryColumn } from '../../../src/storage/dictionary-column.js';
import { DataType } from '../../../src/storage/data-type.js';
import { SpillManager } from '../../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';
import { captureMemoryLimit, limitResidentRows } from '../../helpers/memory-limits.js';

function intChunk(...columns) {
  const size = columns[0].length;
  const cols = columns.map(values => {
    const col = new Column(DataType.INT32, Math.max(values.length, 1));
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function textChunk(values) {
  const col = new DictionaryColumn(Math.max(values.length, 1));
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

function textPairChunk(pairs) {
  const cols = [0, 1].map(c => {
    const col = new DictionaryColumn(Math.max(pairs.length, 1));
    for (let i = 0; i < pairs.length; i++) col.set(i, pairs[i][c]);
    col.length = pairs.length;
    return col;
  });
  return new DataChunk(cols, pairs.length);
}

function rows(chunk) {
  const out = [];
  for (let i = 0; i < chunk.size; i++) {
    const row = [];
    for (let c = 0; c < chunk.columns.length; c++) row.push(chunk.getValue(i, c));
    out.push(row);
  }
  return out;
}

async function drained(dedup) {
  const out = [];
  for await (const chunk of dedup.drain()) out.push(chunk);
  return out;
}

async function drainedValues(dedup) {
  return (await drained(dedup)).flatMap(chunk => rows(chunk)).map(row => row[0]);
}

function spillingDeduplicator() {
  return new ChunkDeduplicator(new SpillManager(new MemoryStorage()));
}

describe('ChunkDeduplicator', () => {
  describe('filter', () => {
    it('passes a chunk with no duplicates through unchanged', async () => {
      const dedup = new ChunkDeduplicator();
      const chunk = intChunk([1, 2, 3]);

      expect(await dedup.filter(chunk)).toBe(chunk);
    });

    it('drops duplicates inside a single chunk', async () => {
      const dedup = new ChunkDeduplicator();

      expect(rows(await dedup.filter(intChunk([1, 1, 2, 2, 3])))).toEqual([[1], [2], [3]]);
    });

    it('drops values already seen in an earlier chunk', async () => {
      const dedup = new ChunkDeduplicator();
      await dedup.filter(intChunk([1, 2]));

      expect(rows(await dedup.filter(intChunk([2, 3])))).toEqual([[3]]);
    });

    it('returns an empty chunk when every row is a duplicate', async () => {
      const dedup = new ChunkDeduplicator();
      await dedup.filter(intChunk([1, 2]));

      expect((await dedup.filter(intChunk([1, 2]))).size).toBe(0);
    });

    it('treats rows as distinct when any column differs', async () => {
      const dedup = new ChunkDeduplicator();

      expect(rows(await dedup.filter(intChunk([1, 1], [1, 2])))).toEqual([[1, 1], [1, 2]]);
    });

    it('treats rows with all columns equal as duplicates', async () => {
      const dedup = new ChunkDeduplicator();

      expect(rows(await dedup.filter(intChunk([1, 1], [7, 7])))).toEqual([[1, 7]]);
    });

    it('deduplicates string values', async () => {
      const dedup = new ChunkDeduplicator();

      expect(rows(await dedup.filter(textChunk(['a', 'b', 'a'])))).toEqual([['a'], ['b']]);
    });

    it('records the schema from the first chunk it sees', async () => {
      const dedup = new ChunkDeduplicator();
      await dedup.filter(intChunk([1]));

      expect(dedup.schema).toEqual([DataType.INT32]);
    });

    it('honours an existing selection vector on the input', async () => {
      const dedup = new ChunkDeduplicator();
      const chunk = intChunk([5, 6, 7, 8]);
      chunk.setSelectionVector(Uint32Array.from([1, 3]), 2);

      expect(rows(await dedup.filter(chunk))).toEqual([[6], [8]]);
    });

    it('handles an empty input chunk', async () => {
      const dedup = new ChunkDeduplicator();

      expect((await dedup.filter(intChunk([]))).size).toBe(0);
    });
  });

  describe('buffer and drain', () => {
    it('drains nothing before any chunk is buffered', async () => {
      expect(await drained(new ChunkDeduplicator())).toEqual([]);
    });

    it('keeps a buffered chunk', async () => {
      const dedup = new ChunkDeduplicator();
      await dedup.buffer(intChunk([1, 2]));

      expect(await drained(dedup)).toHaveLength(1);
    });

    it('ignores an empty chunk', async () => {
      const dedup = new ChunkDeduplicator();
      await dedup.buffer(intChunk([]));

      expect(await drained(dedup)).toEqual([]);
    });

    it('flattens a selection-vector chunk so the buffer holds dense data', async () => {
      const dedup = new ChunkDeduplicator();
      const filtered = await dedup.filter(intChunk([1, 1, 2]));
      await dedup.buffer(filtered);

      const [buffered] = await drained(dedup);
      expect(buffered.selectionVector).toBeNull();
      expect(rows(buffered)).toEqual([[1], [2]]);
    });

    it('preserves buffered chunks in insertion order', async () => {
      const dedup = new ChunkDeduplicator();
      await dedup.buffer(intChunk([1]));
      await dedup.buffer(intChunk([2]));

      expect((await drained(dedup)).map(c => rows(c)[0][0])).toEqual([1, 2]);
    });
  });

  describe('spilling past the memory limit', () => {
    let restoreMemoryLimit;
    beforeEach(() => { restoreMemoryLimit = captureMemoryLimit(); });
    afterEach(() => { restoreMemoryLimit(); });

    it('still emits every distinct value exactly once once the key set has spilled', async () => {
      limitResidentRows([DataType.INT32], 3);
      const dedup = spillingDeduplicator();

      const emitted = [];
      for (const values of [[1, 2, 3, 4], [5, 6, 7, 8], [1, 5, 9]]) {
        emitted.push(...rows(await dedup.filter(intChunk(values))).map(row => row[0]));
      }
      emitted.push(...await drainedValues(dedup));

      expect(dedup.overflowed).toBe(true);
      expect(emitted.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('does not re-emit a value whose only copy was emitted before the spill', async () => {
      limitResidentRows([DataType.INT32], 2);
      const dedup = spillingDeduplicator();

      const emitted = rows(await dedup.filter(intChunk([1, 2, 3]))).map(row => row[0]);
      emitted.push(...rows(await dedup.filter(intChunk([1, 2, 3]))).map(row => row[0]));
      emitted.push(...await drainedValues(dedup));

      expect(emitted.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    });

    it('replays buffered rows that were spilled when the limit was reached', async () => {
      limitResidentRows([DataType.INT32], 4);
      const dedup = spillingDeduplicator();

      for (const values of [[1, 2], [3, 4], [5, 6], [1, 7]]) {
        await dedup.buffer(await dedup.filter(intChunk(values)));
      }

      expect(dedup.spilledEmitted).toBe(true);
      expect((await drainedValues(dedup)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('deduplicates spilled string keys across the spill boundary', async () => {
      limitResidentRows([DataType.VARCHAR], 2);
      const dedup = spillingDeduplicator();

      const emitted = rows(await dedup.filter(textChunk(['a', 'b', 'c']))).map(row => row[0]);
      emitted.push(...rows(await dedup.filter(textChunk(['c', 'd', 'a']))).map(row => row[0]));
      emitted.push(...(await drained(dedup)).flatMap(chunk => rows(chunk)).map(row => row[0]));

      expect(emitted.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('never spills without a spill store, however far past the limit it runs', async () => {
      limitResidentRows([DataType.INT32], 2);
      const dedup = new ChunkDeduplicator();

      const emitted = rows(await dedup.filter(intChunk([1, 2, 3, 4, 5])));

      expect(dedup.overflowed).toBe(false);
      expect(emitted.map(row => row[0])).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('rowKey', () => {
    it('separates columns so concatenation cannot collide', () => {
      const dedup = new ChunkDeduplicator();
      const first = dedup.rowKey(intChunk([1], [23]), 0);
      const second = dedup.rowKey(intChunk([12], [3]), 0);

      expect(first).not.toBe(second);
    });

    it('separates text rows that differ only in where a column boundary falls', () => {
      const dedup = new ChunkDeduplicator();
      const first = dedup.rowKey(textPairChunk([['a|b', 'c']]), 0);
      const second = dedup.rowKey(textPairChunk([['a', 'b|c']]), 0);

      expect(first).not.toBe(second);
    });

    it('separates a null column from the text that spells it', () => {
      const dedup = new ChunkDeduplicator();
      const first = dedup.rowKey(textPairChunk([[null, 'x']]), 0);
      const second = dedup.rowKey(textPairChunk([['null', 'x']]), 0);

      expect(first).not.toBe(second);
    });

    it('produces the same key for identical rows', () => {
      const dedup = new ChunkDeduplicator();

      expect(dedup.rowKey(intChunk([4], [5]), 0)).toBe(dedup.rowKey(intChunk([4], [5]), 0));
    });
  });
});
