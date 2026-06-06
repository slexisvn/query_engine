import { describe, it, expect } from 'vitest';
import { UnionOperator } from '../../../src/execution/operators/union.js';
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

describe('UnionOperator', () => {
  describe('UNION ALL', () => {
    it('passes through all rows without dedup', async () => {
      const op = new UnionOperator(true);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 1, 2, 2] }]);

      const result = await op.process(chunk);

      expect(result.size).toBe(4);
    });

    it('returns original chunk reference (no copy)', async () => {
      const op = new UnionOperator(true);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 2] }]);

      const result = await op.process(chunk);

      expect(result).toBe(chunk);
    });

    it('preserves duplicates across multiple process calls', async () => {
      const op = new UnionOperator(true);
      await op.consume(makeChunk([{ type: 'INT32', values: [1, 2] }]));
      await op.consume(makeChunk([{ type: 'INT32', values: [1, 2] }]));

      const result = await op.finalize();
      const allRows = result.flatMap(c => c.toRows());

      expect(allRows.length).toBe(4);
    });
  });

  describe('UNION (distinct)', () => {
    it('removes duplicate rows within a chunk', async () => {
      const op = new UnionOperator(false);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 2, 1, 3, 2] }]);

      const result = await op.process(chunk);

      expect(result.size).toBe(3);
    });

    it('removes duplicates across chunks', async () => {
      const op = new UnionOperator(false);
      await op.consume(makeChunk([{ type: 'INT32', values: [1, 2, 3] }]));
      await op.consume(makeChunk([{ type: 'INT32', values: [2, 3, 4] }]));

      const result = await op.finalize();
      const allRows = result.flatMap(c => c.toRows());

      expect(allRows.length).toBe(4);
      const vals = allRows.map(r => r[0]);
      expect(vals).toContain(1);
      expect(vals).toContain(2);
      expect(vals).toContain(3);
      expect(vals).toContain(4);
    });

    it('deduplicates on multi-column composite key', async () => {
      const op = new UnionOperator(false);
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 1, 1] },
        { type: 'VARCHAR', values: ['a', 'b', 'a'] },
      ]);

      const result = await op.process(chunk);

      expect(result.size).toBe(2);
    });

    it('returns empty chunk when all rows are duplicates', async () => {
      const op = new UnionOperator(false);
      await op.process(makeChunk([{ type: 'INT32', values: [1, 2] }]));
      const result = await op.process(makeChunk([{ type: 'INT32', values: [1, 2] }]));

      expect(result.size).toBe(0);
    });

    it('returns full chunk when all rows are unique', async () => {
      const op = new UnionOperator(false);
      const chunk = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);

      const result = await op.process(chunk);

      expect(result).toBe(chunk);
    });
  });

  describe('selection vector handling', () => {
    it('reads active rows via selection vector for dedup', async () => {
      const op = new UnionOperator(false);
      const chunk = makeChunk([{ type: 'INT32', values: [10, 20, 30, 40] }]);
      chunk.setSelectionVector(new Uint32Array([0, 2]), 2);

      const result = await op.process(chunk);

      expect(result.size).toBe(2);
    });
  });

  describe('consume/finalize flow', () => {
    it('collects and flattens chunks via consume/finalize', async () => {
      const op = new UnionOperator(false);
      await op.consume(makeChunk([{ type: 'INT32', values: [5, 5, 10] }]));
      await op.consume(makeChunk([{ type: 'INT32', values: [10, 15] }]));

      const result = await op.finalize();
      const allRows = result.flatMap(c => c.toRows());

      expect(allRows.length).toBe(3);
      expect(allRows.map(r => r[0]).sort((a, b) => a - b)).toEqual([5, 10, 15]);
    });

    it('returns empty array when no chunks consumed', async () => {
      const op = new UnionOperator(false);
      const result = await op.finalize();
      expect(result.length).toBe(0);
    });
  });
});
