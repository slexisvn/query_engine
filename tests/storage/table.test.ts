import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Table } from '../../src/storage/table.js';
import { DataType } from '../../src/storage/data-type.js';
import { BTreeIndex } from '../../src/storage/btree.js';
import { FilePageStore } from '../../src/storage/page-store/file-page-store.js';
import { columnAllocator } from '../../src/storage/sab-arena.js';

describe('Table', () => {
  let tmpDir;
  const schema = [
    { name: 'id', dataType: DataType.INT32 },
    { name: 'name', dataType: DataType.VARCHAR },
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'table_test_'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('column lookup', () => {
    it('finds column index case-insensitively', () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      expect(table.getColumnIndex('id')).toBe(0);
      expect(table.getColumnIndex('ID')).toBe(0);
      expect(table.getColumnIndex('Name')).toBe(1);
      expect(table.getColumnIndex('missing')).toBe(-1);
    });

    it('getColumn returns schema entry by name', () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      expect(table.getColumn('NAME')).toBe(schema[1]);
      expect(table.getColumn('nope')).toBeUndefined();
    });
  });

  describe('insert and scan', () => {
    it('round-trips rows through insert → flush → scan', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      await table.insertRows([
        [1, 'alice'],
        [2, 'bob'],
        [3, 'carol'],
      ]);

      const rows = [];
      for await (const chunk of table.scan()) {
        for (let r = 0; r < chunk.size; r++) {
          rows.push([chunk.columns[0].get(r), chunk.columns[1].get(r)]);
        }
      }
      expect(rows).toEqual([
        [1, 'alice'],
        [2, 'bob'],
        [3, 'carol'],
      ]);
    });

    it('handles null values in rows', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      await table.insertRows([
        [1, null],
        [null, 'bob'],
      ]);

      const rows = [];
      for await (const chunk of table.scan()) {
        for (let r = 0; r < chunk.size; r++) {
          rows.push([chunk.columns[0].get(r), chunk.columns[1].get(r)]);
        }
      }
      expect(rows[0]).toEqual([1, null]);
      expect(rows[1]).toEqual([null, 'bob']);
    });
  });

  describe('row count tracking', () => {
    it('counts rows across active chunk and flushed pages', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      expect(table.rowCount()).toBe(0);
      await table.insertRows([[1, 'a'], [2, 'b']]);
      expect(table.rowCount()).toBe(2);
      await table.flush();
      expect(table.rowCount()).toBe(2);
      await table.insertRows([[3, 'c']]);
      expect(table.rowCount()).toBe(3);
    });
  });

  describe('chunk splitting', () => {
    it('creates multiple pages when data exceeds chunk size', async () => {
      const smallSchema = [{ name: 'val', dataType: DataType.INT32 }];
      const table = new Table('t', smallSchema, new FilePageStore(tmpDir, columnAllocator));
      const rows = Array.from({ length: 3000 }, (_, i) => [i]);
      await table.insertRows(rows);
      await table.flush();

      expect(table.pageIds.length).toBeGreaterThan(1);

      const allVals = [];
      for await (const chunk of table.scan()) {
        for (let r = 0; r < chunk.size; r++) {
          allVals.push(chunk.columns[0].get(r));
        }
      }
      expect(allVals.length).toBe(3000);
      expect(allVals[0]).toBe(0);
      expect(allVals[2999]).toBe(2999);
    });
  });

  describe('scanAll', () => {
    it('returns all pages as an array of chunks', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      await table.insertRows([[1, 'a'], [2, 'b'], [3, 'c']]);
      const chunks = await table.scanAll();
      let total = 0;
      for (const c of chunks) total += c.size;
      expect(total).toBe(3);
    });
  });

  describe('index integration', () => {
    it('indexes populated during addChunk enable point lookup', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      const idx = new BTreeIndex(DataType.INT32);
      table.registerIndex(0, idx);

      await table.insertRows([
        [10, 'alice'],
        [20, 'bob'],
        [30, 'carol'],
      ]);
      await table.flush();

      expect(idx.search(20)).toHaveLength(1);
      expect(idx.search(20)[0].rowIndex).toBe(1);
      expect(idx.search(99)).toEqual([]);
    });

    it('index skips null keys', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      const idx = new BTreeIndex(DataType.INT32);
      table.registerIndex(0, idx);

      await table.insertRows([
        [null, 'nobody'],
        [10, 'alice'],
      ]);
      await table.flush();

      expect(idx.search(10)).toHaveLength(1);
    });

    it('index spans multiple chunks', async () => {
      const smallSchema = [{ name: 'val', dataType: DataType.INT32 }];
      const table = new Table('t', smallSchema, new FilePageStore(tmpDir, columnAllocator));
      const idx = new BTreeIndex(DataType.INT32);
      table.registerIndex(0, idx);

      const rows = Array.from({ length: 3000 }, (_, i) => [i]);
      await table.insertRows(rows);
      await table.flush();

      expect(table.pageIds.length).toBeGreaterThan(1);
      expect(idx.search(0)).toHaveLength(1);
      expect(idx.search(2999)).toHaveLength(1);
    });
  });

  describe('flush behavior', () => {
    it('is idempotent', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      await table.insertRows([[1, 'a']]);
      await table.flush();
      await table.flush();
      await table.flush();
      expect(table.pageIds.length).toBe(1);
    });

    it('no-ops when nothing to flush', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      await table.flush();
      expect(table.pageIds.length).toBe(0);
    });

    it('scan auto-flushes active chunk', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      await table.insertRows([[1, 'a']]);
      const rows = [];
      for await (const chunk of table.scan()) {
        for (let r = 0; r < chunk.size; r++) {
          rows.push(chunk.columns[0].get(r));
        }
      }
      expect(rows).toEqual([1]);
      expect(table.activeChunk).toBeNull();
    });
  });

  describe('multiple insert batches', () => {
    it('accumulates rows across multiple insertRows calls', async () => {
      const table = new Table('t', schema, new FilePageStore(tmpDir, columnAllocator));
      await table.insertRows([[1, 'a']]);
      await table.insertRows([[2, 'b']]);
      await table.insertRows([[3, 'c']]);
      expect(table.rowCount()).toBe(3);

      const rows = [];
      for await (const chunk of table.scan()) {
        for (let r = 0; r < chunk.size; r++) {
          rows.push(chunk.columns[0].get(r));
        }
      }
      expect(rows).toEqual([1, 2, 3]);
    });
  });
});
