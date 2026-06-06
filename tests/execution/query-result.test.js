import { describe, it, expect } from 'vitest';
import { QueryResult } from '../../src/execution/query-result.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';

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

function mockSink(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe('QueryResult', () => {
  describe('columns', () => {
    it('returns column names', () => {
      const result = new QueryResult(['id', 'name'], mockSink([]));
      expect(result.columns).toEqual(['id', 'name']);
    });
  });

  describe('toArray', () => {
    it('converts chunks into array of row objects', async () => {
      const chunks = [
        makeChunk([
          { type: 'INT32', values: [1, 2] },
          { type: 'VARCHAR', values: ['alice', 'bob'] },
        ]),
      ];
      const result = new QueryResult(['id', 'name'], mockSink(chunks));
      const rows = await result.toArray();

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual({ id: 1, name: 'alice' });
      expect(rows[1]).toEqual({ id: 2, name: 'bob' });
    });

    it('handles multiple chunks', async () => {
      const chunks = [
        makeChunk([{ type: 'INT32', values: [1] }]),
        makeChunk([{ type: 'INT32', values: [2] }]),
      ];
      const result = new QueryResult(['val'], mockSink(chunks));
      const rows = await result.toArray();

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual({ val: 1 });
      expect(rows[1]).toEqual({ val: 2 });
    });

    it('converts bigint to number', async () => {
      const chunks = [makeChunk([{ type: 'INT64', values: [100n, 200n] }])];
      const result = new QueryResult(['big'], mockSink(chunks));
      const rows = await result.toArray();

      expect(typeof rows[0].big).toBe('number');
      expect(rows[0].big).toBe(100);
      expect(rows[1].big).toBe(200);
    });

    it('returns empty array for no data', async () => {
      const result = new QueryResult(['x'], mockSink([]));
      const rows = await result.toArray();
      expect(rows).toEqual([]);
    });

    it('handles null values', async () => {
      const chunks = [makeChunk([{ type: 'INT32', values: [1, null, 3] }])];
      const result = new QueryResult(['val'], mockSink(chunks));
      const rows = await result.toArray();

      expect(rows[1]).toEqual({ val: null });
    });
  });

  describe('async iterator', () => {
    it('yields row objects one at a time', async () => {
      const chunks = [
        makeChunk([
          { type: 'INT32', values: [10, 20] },
          { type: 'VARCHAR', values: ['x', 'y'] },
        ]),
      ];
      const result = new QueryResult(['id', 'label'], mockSink(chunks));
      const rows = [];
      for await (const row of result) {
        rows.push(row);
      }

      expect(rows).toEqual([
        { id: 10, label: 'x' },
        { id: 20, label: 'y' },
      ]);
    });

    it('converts bigint in iterator', async () => {
      const chunks = [makeChunk([{ type: 'INT64', values: [42n] }])];
      const result = new QueryResult(['n'], mockSink(chunks));
      const rows = [];
      for await (const row of result) rows.push(row);

      expect(typeof rows[0].n).toBe('number');
    });
  });

  describe('chunks generator', () => {
    it('yields raw DataChunks', async () => {
      const c1 = makeChunk([{ type: 'INT32', values: [1, 2] }]);
      const c2 = makeChunk([{ type: 'INT32', values: [3] }]);
      const result = new QueryResult(['val'], mockSink([c1, c2]));

      const collected = [];
      for await (const chunk of result.chunks()) {
        collected.push(chunk);
      }

      expect(collected.length).toBe(2);
      expect(collected[0].size).toBe(2);
      expect(collected[1].size).toBe(1);
    });
  });

  describe('selection vector handling', () => {
    it('reads active rows through selection vector', async () => {
      const chunk = makeChunk([{ type: 'INT32', values: [10, 20, 30, 40] }]);
      chunk.setSelectionVector(new Uint32Array([1, 3]), 2);

      const result = new QueryResult(['val'], mockSink([chunk]));
      const rows = await result.toArray();

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual({ val: 20 });
      expect(rows[1]).toEqual({ val: 40 });
    });
  });
});
