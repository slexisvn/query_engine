import { describe, it, expect } from 'vitest';
import { DistinctOperator } from '../../../src/execution/operators/distinct.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function chunkRows(chunk) {
  const rows = [];
  for (let i = 0; i < chunk.size; i++) {
    const row = [];
    for (let c = 0; c < chunk.columns.length; c++) {
      row.push(chunk.getValue(i, c));
    }
    rows.push(row);
  }
  return rows;
}

describe('DistinctOperator', () => {
  describe('process - single chunk', () => {
    it('removes duplicate rows within a single chunk', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2, 1, 3, 2] },
      ]);

      const result = await op.process(chunk);

      const rows = chunkRows(result);
      const vals = rows.map(r => r[0]);
      expect(vals).toEqual([1, 2, 3]);
    });

    it('returns all rows when no duplicates', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2, 3, 4] },
      ]);

      const result = await op.process(chunk);

      expect(result.size).toBe(4);
    });

    it('returns empty chunk when all rows are identical', async () => {
      const op = new DistinctOperator();
      const chunk1 = makeChunk([{ type: 'INT32', values: [5] }]);
      await op.process(chunk1);

      const chunk2 = makeChunk([{ type: 'INT32', values: [5, 5, 5] }]);
      const result = await op.process(chunk2);

      expect(result.size).toBe(0);
    });
  });

  describe('process - multi-column dedup', () => {
    it('deduplicates based on all columns combined', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 1, 1, 2] },
        { type: 'VARCHAR', values: ['a', 'b', 'a', 'a'] },
      ]);

      const result = await op.process(chunk);

      const rows = chunkRows(result);
      expect(rows).toEqual([
        [1, 'a'],
        [1, 'b'],
        [2, 'a'],
      ]);
    });

    it('treats rows with same values in different column order as distinct', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'INT32', values: [2, 1] },
      ]);

      const result = await op.process(chunk);

      expect(result.size).toBe(2);
    });
  });

  describe('process - cross-chunk dedup', () => {
    it('remembers seen rows across multiple process calls', async () => {
      const op = new DistinctOperator();
      const chunk1 = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);
      await op.process(chunk1);

      const chunk2 = makeChunk([{ type: 'INT32', values: [2, 4, 1] }]);
      const result = await op.process(chunk2);

      const rows = chunkRows(result);
      expect(rows.map(r => r[0])).toEqual([4]);
    });

    it('returns empty chunk when second chunk is all duplicates', async () => {
      const op = new DistinctOperator();
      const chunk1 = makeChunk([{ type: 'INT32', values: [1, 2] }]);
      await op.process(chunk1);

      const chunk2 = makeChunk([{ type: 'INT32', values: [1, 2] }]);
      const result = await op.process(chunk2);

      expect(result.size).toBe(0);
    });
  });

  describe('consume + finalize', () => {
    it('collects unique rows and returns flattened chunks', async () => {
      const op = new DistinctOperator();
      const chunk1 = makeChunk([{ type: 'INT32', values: [1, 2, 1] }]);
      const chunk2 = makeChunk([{ type: 'INT32', values: [2, 3] }]);
      await op.consume(chunk1);
      await op.consume(chunk2);

      const result = await op.finalize();

      const allRows = result.flatMap(c => chunkRows(c));
      const vals = allRows.map(r => r[0]);
      expect(vals).toEqual([1, 2, 3]);
    });

    it('returns empty array when no chunks consumed', async () => {
      const op = new DistinctOperator();

      const result = await op.finalize();

      expect(result).toEqual([]);
    });

    it('skips empty chunks from consume', async () => {
      const op = new DistinctOperator();
      const chunk1 = makeChunk([{ type: 'INT32', values: [1, 2] }]);
      await op.consume(chunk1);

      const chunk2 = makeChunk([{ type: 'INT32', values: [1, 2] }]);
      await op.consume(chunk2);

      const result = await op.finalize();

      expect(result.length).toBe(1);
    });
  });

  describe('data type handling', () => {
    it('deduplicates VARCHAR columns', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'VARCHAR', values: ['hello', 'world', 'hello', 'foo'] },
      ]);

      const result = await op.process(chunk);

      const rows = chunkRows(result);
      expect(rows.map(r => r[0])).toEqual(['hello', 'world', 'foo']);
    });

    it('deduplicates FLOAT64 columns', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'FLOAT64', values: [1.5, 2.5, 1.5, 3.5] },
      ]);

      const result = await op.process(chunk);

      expect(result.size).toBe(3);
    });

    it('deduplicates BOOLEAN columns', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'BOOLEAN', values: [true, false, true, false, true] },
      ]);

      const result = await op.process(chunk);

      expect(result.size).toBe(2);
    });
  });

  describe('selection vector output', () => {
    it('uses selection vector when partial dedup within chunk', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2, 1, 3] },
      ]);

      const result = await op.process(chunk);

      expect(result.size).toBe(3);
      expect(result.getValue(0, 0)).toBe(1);
      expect(result.getValue(1, 0)).toBe(2);
      expect(result.getValue(2, 0)).toBe(3);
    });
  });

  describe('null handling', () => {
    it('treats null as a distinct value', async () => {
      const op = new DistinctOperator();
      const chunk = makeChunk([
        { type: 'INT32', values: [1, null, null, 2] },
      ]);

      const result = await op.process(chunk);

      expect(result.size).toBe(3);
    });
  });
});
