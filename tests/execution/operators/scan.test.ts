import { describe, it, expect } from 'vitest';
import { ScanOperator } from '../../../src/execution/operators/scan.js';
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

function makeTable(chunks) {
  return {
    async *scan() {
      for (const c of chunks) yield c;
    },
  };
}

async function collectChunks(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

describe('ScanOperator', () => {
  describe('full scan', () => {
    it('yields all chunks from table', async () => {
      const c1 = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);
      const c2 = makeChunk([{ type: 'INT32', values: [4, 5] }]);
      const table = makeTable([c1, c2]);
      const op = new ScanOperator(table);

      const result = await collectChunks(op.scan());

      expect(result.length).toBe(2);
      expect(result[0].size).toBe(3);
      expect(result[1].size).toBe(2);
    });

    it('passes through all columns when no projection', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'VARCHAR', values: ['a'] },
        { type: 'FLOAT64', values: [3.14] },
      ]);
      const op = new ScanOperator(makeTable([chunk]));

      const result = await collectChunks(op.scan());

      expect(result[0].columns.length).toBe(3);
      expect(result[0].columns[0].get(0)).toBe(1);
      expect(result[0].columns[1].get(0)).toBe('a');
      expect(result[0].columns[2].get(0)).toBe(3.14);
    });

    it('returns empty for empty table', async () => {
      const op = new ScanOperator(makeTable([]));

      const result = await collectChunks(op.scan());

      expect(result.length).toBe(0);
    });
  });

  describe('projected scan', () => {
    it('returns only projected column indices', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'VARCHAR', values: ['a', 'b'] },
        { type: 'FLOAT64', values: [1.1, 2.2] },
      ]);
      const op = new ScanOperator(makeTable([chunk]), [0, 2]);

      const result = await collectChunks(op.scan());

      expect(result[0].columns.length).toBe(2);
      expect(result[0].columns[0].get(0)).toBe(1);
      expect(result[0].columns[1].get(0)).toBe(1.1);
    });

    it('can reorder columns via projection', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [10] },
        { type: 'VARCHAR', values: ['hello'] },
      ]);
      const op = new ScanOperator(makeTable([chunk]), [1, 0]);

      const result = await collectChunks(op.scan());

      expect(result[0].columns[0].get(0)).toBe('hello');
      expect(result[0].columns[1].get(0)).toBe(10);
    });

    it('projects a single column', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
        { type: 'FLOAT64', values: [1.0, 2.0, 3.0] },
      ]);
      const op = new ScanOperator(makeTable([chunk]), [1]);

      const result = await collectChunks(op.scan());

      expect(result[0].columns.length).toBe(1);
      expect(result[0].columns[0].get(0)).toBe('a');
      expect(result[0].columns[0].get(1)).toBe('b');
      expect(result[0].columns[0].get(2)).toBe('c');
    });

    it('applies projection to each chunk in multi-chunk scan', async () => {
      const c1 = makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'VARCHAR', values: ['x'] },
      ]);
      const c2 = makeChunk([
        { type: 'INT32', values: [2] },
        { type: 'VARCHAR', values: ['y'] },
      ]);
      const op = new ScanOperator(makeTable([c1, c2]), [1]);

      const result = await collectChunks(op.scan());

      expect(result.length).toBe(2);
      expect(result[0].columns.length).toBe(1);
      expect(result[0].columns[0].get(0)).toBe('x');
      expect(result[1].columns[0].get(0)).toBe('y');
    });
  });
});
