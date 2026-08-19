import { describe, it, expect } from 'vitest';
import { FilterOperator } from '../../../src/execution/operators/filter.js';
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
    for (let c = 0; c < chunk.columns.length; c++) row.push(chunk.getValue(i, c));
    rows.push(row);
  }
  return rows;
}

describe('FilterOperator', () => {
  describe('basic filtering', () => {
    it('keeps rows where evaluator returns true', async () => {
      const op = new FilterOperator(null, (chunk, row) => chunk.columns[0].get(row) > 2);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 2, 3, 4, 5] }]);

      const result = await op.process(chunk);

      const vals = chunkRows(result).map(r => r[0]);
      expect(vals).toEqual([3, 4, 5]);
    });

    it('returns empty chunk when no rows match', async () => {
      const op = new FilterOperator(null, (chunk, row) => chunk.columns[0].get(row) > 100);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);

      const result = await op.process(chunk);

      expect(result.size).toBe(0);
    });

    it('returns original chunk when all rows match', async () => {
      const op = new FilterOperator(null, () => true);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);

      const result = await op.process(chunk);

      expect(result).toBe(chunk);
      expect(result.size).toBe(3);
    });

    it('handles empty input chunk', async () => {
      const op = new FilterOperator(null, () => true);
      const chunk = new DataChunk([new Column('INT32', 0)], 0);

      const result = await op.process(chunk);

      expect(result.size).toBe(0);
    });
  });

  describe('multi-column filtering', () => {
    it('filters based on multiple columns', async () => {
      const op = new FilterOperator(null, (chunk, row) =>
        chunk.columns[0].get(row) > 1 && chunk.columns[1].get(row) < 30
      );
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2, 3, 4] },
        { type: 'INT32', values: [10, 20, 30, 40] },
      ]);

      const result = await op.process(chunk);

      const rows = chunkRows(result);
      expect(rows).toEqual([[2, 20]]);
    });
  });

  describe('selection vector handling', () => {
    it('respects existing selection vector on input chunk', async () => {
      const op = new FilterOperator(null, (chunk, row) => chunk.columns[0].get(row) > 2);
      const col = new Column('INT32', 5);
      [1, 2, 3, 4, 5].forEach((v, i) => col.set(i, v));
      col.length = 5;
      const chunk = new DataChunk([col], 3);
      chunk.setSelectionVector(new Uint32Array([0, 2, 4]), 3);

      const result = await op.process(chunk);

      const vals = chunkRows(result).map(r => r[0]);
      expect(vals).toEqual([3, 5]);
    });

    it('produces selection vector for partial matches', async () => {
      const op = new FilterOperator(null, (chunk, row) => chunk.columns[0].get(row) % 2 === 0);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 2, 3, 4, 5, 6] }]);

      const result = await op.process(chunk);

      expect(result.size).toBe(3);
      expect(result.selectionVector).not.toBeNull();
      const vals = chunkRows(result).map(r => r[0]);
      expect(vals).toEqual([2, 4, 6]);
    });
  });

  describe('string column filtering', () => {
    it('filters on VARCHAR values', async () => {
      const op = new FilterOperator(null, (chunk, row) =>
        chunk.columns[0].get(row) === 'hello'
      );
      const chunk = makeChunk([
        { type: 'VARCHAR', values: ['hello', 'world', 'hello', 'foo'] },
      ]);

      const result = await op.process(chunk);

      expect(result.size).toBe(2);
    });
  });

  describe('null handling', () => {
    it('null values are passed to evaluator correctly', async () => {
      const op = new FilterOperator(null, (chunk, row) =>
        chunk.columns[0].get(row) !== null
      );
      const chunk = makeChunk([{ type: 'INT32', values: [1, null, 3, null, 5] }]);

      const result = await op.process(chunk);

      const vals = chunkRows(result).map(r => r[0]);
      expect(vals).toEqual([1, 3, 5]);
    });
  });

  describe('preserves column data', () => {
    it('output chunk references same column objects as input', async () => {
      const op = new FilterOperator(null, (chunk, row) => chunk.columns[0].get(row) > 1);
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]);

      const result = await op.process(chunk);

      expect(result.columns[0]).toBe(chunk.columns[0]);
      expect(result.columns[1]).toBe(chunk.columns[1]);
    });
  });

  describe('single row matching', () => {
    it('handles single matching row', async () => {
      const op = new FilterOperator(null, (chunk, row) => chunk.columns[0].get(row) === 42);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 42, 3] }]);

      const result = await op.process(chunk);

      expect(result.size).toBe(1);
      expect(result.getValue(0, 0)).toBe(42);
    });
  });
});
