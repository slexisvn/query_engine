import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Table } from '../../src/storage/table.js';
import { DataType } from '../../src/storage/data-type.js';
import { BTreeIndex } from '../../src/storage/btree.js';
import { FilePageStore } from '../../src/storage/page-store/file-page-store.js';
import { columnAllocator } from '../../src/storage/sab-arena.js';
import { Config, DEFAULT_CHUNK_SIZE } from '../../src/config.js';
import { MemoryPageStore } from '../../src/storage/page-store/memory-page-store.js';
import { ColumnForm, columnFormOf, columnRetainedBytes } from '../../src/storage/column-codec.js';
import { EncodingKind } from '../../src/storage/encoding/encoding-types.js';

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

  describe('zone maps', () => {
    async function tableWithPages(pageStore) {
      const table = new Table('t', schema, pageStore);
      for (let page = 0; page < 3; page++) {
        const rows = [];
        for (let i = 0; i < DEFAULT_CHUNK_SIZE; i++) {
          const id = page * DEFAULT_CHUNK_SIZE + i;
          rows.push([id, id % 5 === 0 ? null : `n${id}`]);
        }
        await table.insertRows(rows);
      }
      await table.flush();
      return table;
    }

    it('records one summary per page as pages are written', async () => {
      const table = await tableWithPages(new FilePageStore(tmpDir, columnAllocator));

      expect(table.zoneMaps).toHaveLength(table.pageIds.length);
      expect(table.zoneMaps[0].columns[0].range).toEqual({ min: 0, max: DEFAULT_CHUNK_SIZE - 1 });
      expect(table.zoneMaps[1].columns[0].range).toEqual({ min: DEFAULT_CHUNK_SIZE, max: 2 * DEFAULT_CHUNK_SIZE - 1 });
      expect(table.zoneMaps[0].columns[0].hasNulls).toBe(false);
      expect(table.zoneMaps[0].columns[1].hasNulls).toBe(true);
    });

    it('skips pages the pruner rejects without fetching them', async () => {
      const store = new FilePageStore(tmpDir, columnAllocator);
      const table = await tableWithPages(store);
      const fetched = [];
      const originalRead = store.read.bind(store);
      store.read = async (pageId) => { fetched.push(pageId); return originalRead(pageId); };

      const onlyLastPage = { canSkip: (zoneMap) => zoneMap.columns[0].range.min < 2 * DEFAULT_CHUNK_SIZE };
      const seen = [];
      for await (const chunk of table.scan(onlyLastPage)) seen.push(chunk.columns[0].get(0));

      expect(seen).toEqual([2 * DEFAULT_CHUNK_SIZE]);
      expect(fetched).toEqual([table.pageIds[2]]);
    });
  });
  describe('column encoding on write', () => {
    const ENCODED_SCHEMA = [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'segment', dataType: DataType.INT32 },
      { name: 'price', dataType: DataType.FLOAT64 },
    ];
    const RUN = 256;
    const savedEncoding = Config.columnEncoding;

    afterEach(() => { Config.columnEncoding = savedEncoding; });

    function encodableRows(count = DEFAULT_CHUNK_SIZE) {
      return Array.from({ length: count }, (_, i) => [
        i,
        Math.floor(i / RUN),
        i % 5 === 0 ? null : i / 2,
      ]);
    }

    async function storedTable(store, rows = encodableRows()) {
      const table = new Table('enc', ENCODED_SCHEMA, store);
      await table.insertRows(rows);
      await table.flush();
      return table;
    }

    async function storedForms(table) {
      const chunk = await table.pageCache.readPage(table.pageIds[0]);
      return chunk.columns.map(column => (
        columnFormOf(column) === ColumnForm.ENCODED ? column.encoded.kind : ColumnForm.FLAT
      ));
    }

    it('stores integer columns encoded and leaves other types flat', async () => {
      const table = await storedTable(new MemoryPageStore());

      expect(await storedForms(table)).toEqual([
        EncodingKind.BIT_PACKED,
        EncodingKind.RUN_LENGTH,
        ColumnForm.FLAT,
      ]);
    });

    it('stores everything flat when encoding is switched off', async () => {
      Config.columnEncoding = false;
      const table = await storedTable(new MemoryPageStore());

      expect(await storedForms(table)).toEqual([ColumnForm.FLAT, ColumnForm.FLAT, ColumnForm.FLAT]);
    });

    it('scans back exactly the rows that were inserted', async () => {
      const rows = encodableRows(600);
      const table = await storedTable(new MemoryPageStore(), rows);

      const seen = [];
      for await (const chunk of table.scan()) {
        for (let i = 0; i < chunk.size; i++) {
          seen.push([chunk.getValue(i, 0), chunk.getValue(i, 1), chunk.getValue(i, 2)]);
        }
      }

      expect(seen).toEqual(rows);
    });

    it('round-trips encoded columns through disk serialization', async () => {
      const rows = encodableRows(600);
      const table = await storedTable(new FilePageStore(tmpDir, columnAllocator), rows);

      expect(await storedForms(table)).toEqual([
        EncodingKind.BIT_PACKED,
        EncodingKind.RUN_LENGTH,
        ColumnForm.FLAT,
      ]);

      const seen = [];
      for await (const chunk of table.scan()) {
        for (let i = 0; i < chunk.size; i++) seen.push(chunk.getValue(i, 1));
      }
      expect(seen).toEqual(rows.map(row => row[1]));
    });

    it('keeps the stored page encoded after a scan decodes the chunk it handed out', async () => {
      const store = new MemoryPageStore();
      const table = await storedTable(store);

      for await (const chunk of table.scan()) {
        expect(Array.from(chunk.columns[1].data).slice(0, RUN)).toEqual(new Array(RUN).fill(0));
      }

      const stored = store.pages.get(table.pageIds[0]);
      expect(columnFormOf(stored.columns[1])).toBe(ColumnForm.ENCODED);
    });

    it('summarizes encoded columns into zone maps with the right ranges', async () => {
      const table = await storedTable(new MemoryPageStore());

      expect(table.zoneMaps[0].columns[0].range).toEqual({ min: 0, max: DEFAULT_CHUNK_SIZE - 1 });
      expect(table.zoneMaps[0].columns[1].range).toEqual({ min: 0, max: Math.floor((DEFAULT_CHUNK_SIZE - 1) / RUN) });
      expect(table.zoneMaps[0].columns[2].hasNulls).toBe(true);
    });

    it('indexes rows of an encoded chunk at the right page offsets', async () => {
      const table = new Table('enc', ENCODED_SCHEMA, new MemoryPageStore());
      const btree = new BTreeIndex(DataType.INT32);
      table.registerIndex(0, btree);
      await table.insertRows(encodableRows());
      await table.flush();

      expect(btree.search(1234)).toEqual([{ pageId: table.pageIds[0], rowIndex: 1234 }]);
    });

    it('retains fewer bytes than the same table stored flat', async () => {
      const measure = async () => {
        const store = new MemoryPageStore();
        await storedTable(store);
        let total = 0;
        for (const chunk of store.pages.values()) {
          for (const column of chunk.columns) total += columnRetainedBytes(column);
        }
        return total;
      };

      const encoded = await measure();
      Config.columnEncoding = false;
      const flat = await measure();

      expect(encoded).toBeLessThan(flat);
    });
  });
});
