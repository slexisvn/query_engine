import { describe, it, expect } from 'vitest';
import { IndexScanOperator } from '../../../src/execution/operators/index-scan.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';

function makePage(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return { columns: cols, size };
}

function makeTable(pages, schema) {
  const pageMap = new Map();
  pages.forEach((p, i) => pageMap.set(i, p));
  return {
    getSchema: () => schema,
    pageCache: {
      fetchPage: async (pageId) => pageMap.get(pageId),
    },
  };
}

function makeBTree(data) {
  return {
    search(key) {
      return data.filter(d => d.key === key).map(d => ({ pageId: d.pageId, rowIndex: d.rowIndex }));
    },
    *range(low, high, lowInc, highInc) {
      for (const d of data) {
        const aboveLow = lowInc ? d.key >= low : d.key > low;
        const belowHigh = highInc ? d.key <= high : d.key < high;
        if (aboveLow && belowHigh) yield { pageId: d.pageId, rowIndex: d.rowIndex };
      }
    },
  };
}

async function collectChunks(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

describe('IndexScanOperator', () => {
  const schema = [
    { name: 'id', dataType: 'INT32' },
    { name: 'name', dataType: 'VARCHAR' },
    { name: 'age', dataType: 'INT32' },
  ];

  const page0 = makePage([
    { type: 'INT32', values: [1, 2, 3] },
    { type: 'VARCHAR', values: ['alice', 'bob', 'charlie'] },
    { type: 'INT32', values: [25, 30, 35] },
  ]);

  const page1 = makePage([
    { type: 'INT32', values: [4, 5] },
    { type: 'VARCHAR', values: ['dave', 'eve'] },
    { type: 'INT32', values: [40, 28] },
  ]);

  const table = makeTable([page0, page1], schema);

  const btreeData = [
    { key: 1, pageId: 0, rowIndex: 0 },
    { key: 2, pageId: 0, rowIndex: 1 },
    { key: 3, pageId: 0, rowIndex: 2 },
    { key: 4, pageId: 1, rowIndex: 0 },
    { key: 5, pageId: 1, rowIndex: 1 },
  ];

  describe('point scan', () => {
    it('returns matching row for exact key lookup', async () => {
      const btree = makeBTree(btreeData);
      const op = new IndexScanOperator(btree, table, 'point', 3, null, null, false, false, null);

      const chunks = await collectChunks(op.scan());

      expect(chunks.length).toBe(1);
      expect(chunks[0].size).toBe(1);
      expect(chunks[0].getValue(0, 0)).toBe(3);
      expect(chunks[0].getValue(0, 1)).toBe('charlie');
    });

    it('returns empty when key does not exist', async () => {
      const btree = makeBTree(btreeData);
      const op = new IndexScanOperator(btree, table, 'point', 99, null, null, false, false, null);

      const chunks = await collectChunks(op.scan());

      expect(chunks.length).toBe(0);
    });

    it('returns multiple rows for duplicate keys', async () => {
      const dupData = [
        { key: 1, pageId: 0, rowIndex: 0 },
        { key: 1, pageId: 0, rowIndex: 1 },
      ];
      const btree = makeBTree(dupData);
      const op = new IndexScanOperator(btree, table, 'point', 1, null, null, false, false, null);

      const chunks = await collectChunks(op.scan());
      const totalRows = chunks.reduce((s, c) => s + c.size, 0);

      expect(totalRows).toBe(2);
    });
  });

  describe('range scan', () => {
    it('returns rows within inclusive range', async () => {
      const btree = makeBTree(btreeData);
      const op = new IndexScanOperator(btree, table, 'range', null, 2, 4, true, true, null);

      const chunks = await collectChunks(op.scan());
      const totalRows = chunks.reduce((s, c) => s + c.size, 0);

      expect(totalRows).toBe(3);
    });

    it('respects exclusive bounds', async () => {
      const btree = makeBTree(btreeData);
      const op = new IndexScanOperator(btree, table, 'range', null, 2, 4, false, false, null);

      const chunks = await collectChunks(op.scan());
      const totalRows = chunks.reduce((s, c) => s + c.size, 0);

      expect(totalRows).toBe(1);
      expect(chunks[0].getValue(0, 0)).toBe(3);
    });

    it('returns empty for range with no matches', async () => {
      const btree = makeBTree(btreeData);
      const op = new IndexScanOperator(btree, table, 'range', null, 10, 20, true, true, null);

      const chunks = await collectChunks(op.scan());

      expect(chunks.length).toBe(0);
    });
  });

  describe('column projection', () => {
    it('returns only projected columns', async () => {
      const btree = makeBTree(btreeData);
      const op = new IndexScanOperator(btree, table, 'point', 2, null, null, false, false, [0, 2]);

      const chunks = await collectChunks(op.scan());

      expect(chunks[0].columns.length).toBe(2);
      expect(chunks[0].getValue(0, 0)).toBe(2);
      expect(chunks[0].getValue(0, 1)).toBe(30);
    });

    it('returns all columns when projectedColumns is null', async () => {
      const btree = makeBTree(btreeData);
      const op = new IndexScanOperator(btree, table, 'point', 1, null, null, false, false, null);

      const chunks = await collectChunks(op.scan());

      expect(chunks[0].columns.length).toBe(3);
    });
  });

  describe('cross-page scan', () => {
    it('fetches rows from multiple pages', async () => {
      const btree = makeBTree(btreeData);
      const op = new IndexScanOperator(btree, table, 'range', null, 1, 5, true, true, null);

      const chunks = await collectChunks(op.scan());
      const allRows = chunks.flatMap(c => c.toRows());

      expect(allRows.length).toBe(5);
      const names = allRows.map(r => r[1]);
      expect(names).toContain('alice');
      expect(names).toContain('eve');
    });
  });
});
