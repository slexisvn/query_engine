import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPagedTableStorage } from '../../src/storage/table-storage.js';
import { Table } from '../../src/storage/table.js';
import { FilePageStore } from '../../src/storage/page-store/file-page-store.js';
import { MemoryPageStore } from '../../src/storage/page-store/memory-page-store.js';
import { columnAllocator } from '../../src/storage/sab-arena.js';
import { InMemoryRelation } from '../../src/dataframe/in-memory-relation.js';
import { DataType } from '../../src/storage/data-type.js';

const SCHEMA = [
  { name: 'ID', dataType: DataType.INT32 },
  { name: 'NAME', dataType: DataType.VARCHAR },
];

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-table-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function relation() {
  return InMemoryRelation.fromRows([{ ID: 1, NAME: 'a' }, { ID: 2, NAME: 'b' }]);
}

function pagedTable() {
  return new Table('T', SCHEMA, new MemoryPageStore());
}

describe('isPagedTableStorage', () => {
  it('accepts a paged table', () => {
    expect(isPagedTableStorage(pagedTable())).toBe(true);
  });

  it('accepts a paged table backed by files', () => {
    expect(isPagedTableStorage(new Table('T', SCHEMA, new FilePageStore(tmpDir, columnAllocator)))).toBe(true);
  });

  it('rejects an in-memory relation', () => {
    expect(isPagedTableStorage(relation())).toBe(false);
  });

  it('rejects a bare object that only implements the read surface', () => {
    const readOnly = {
      getSchema: () => SCHEMA,
      rowCount: () => 0,
      getColumnIndex: () => -1,
      scan: async function* () {},
      scanAll: async () => [],
    };

    expect(isPagedTableStorage(readOnly)).toBe(false);
  });
});

describe('TableStorage read surface', () => {
  it('is satisfied by an in-memory relation', () => {
    const storage = relation();

    expect(typeof storage.getSchema).toBe('function');
    expect(typeof storage.rowCount).toBe('function');
    expect(typeof storage.getColumnIndex).toBe('function');
    expect(typeof storage.scan).toBe('function');
    expect(typeof storage.scanAll).toBe('function');
  });

  it('is satisfied by a paged table', () => {
    const storage = pagedTable();

    expect(typeof storage.getSchema).toBe('function');
    expect(typeof storage.rowCount).toBe('function');
    expect(typeof storage.getColumnIndex).toBe('function');
    expect(typeof storage.scan).toBe('function');
    expect(typeof storage.scanAll).toBe('function');
  });

  it('reports the row count of an in-memory relation', () => {
    expect(relation().rowCount()).toBe(2);
  });

  it('resolves a column index by name on an in-memory relation', () => {
    expect(relation().getColumnIndex('NAME')).toBe(1);
  });

  it('returns -1 for an unknown column on an in-memory relation', () => {
    expect(relation().getColumnIndex('MISSING')).toBe(-1);
  });

  it('returns every chunk from scanAll on an in-memory relation', async () => {
    const chunks = await relation().scanAll();
    const total = chunks.reduce((sum, chunk) => sum + chunk.size, 0);

    expect(total).toBe(2);
  });

  it('returns the same rows from scan and scanAll on an in-memory relation', async () => {
    const storage = relation();
    let streamed = 0;
    for await (const chunk of storage.scan()) streamed += chunk.size;
    const collected = (await storage.scanAll()).reduce((sum, chunk) => sum + chunk.size, 0);

    expect(streamed).toBe(collected);
  });

  it('returns the same rows from scan and scanAll on a paged table', async () => {
    const table = pagedTable();
    await table.insertRows([[1, 'a'], [2, 'b'], [3, 'c']]);
    await table.flush();

    let streamed = 0;
    for await (const chunk of table.scan()) streamed += chunk.size;
    const collected = (await table.scanAll()).reduce((sum, chunk) => sum + chunk.size, 0);

    expect(streamed).toBe(3);
    expect(collected).toBe(3);
  });
});

describe('PagedTableStorage surface', () => {
  it('exposes page identifiers after a flush', async () => {
    const table = pagedTable();
    await table.insertRows([[1, 'a']]);
    await table.flush();

    expect(table.pageIds.length).toBeGreaterThan(0);
  });

  it('exposes a page cache that can fetch a written page', async () => {
    const table = pagedTable();
    await table.insertRows([[1, 'a']]);
    await table.flush();

    const chunk = await table.pageCache.fetchPage(table.pageIds[0], true);

    expect(chunk.size).toBe(1);
  });

  it('starts with no registered indexes', () => {
    expect(pagedTable().indexes).toEqual([]);
  });
});
