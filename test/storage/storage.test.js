import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DataType, dateToEpochDays, epochDaysToDate, DECIMAL_SCALE } from '../../src/storage/data-type.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk, DEFAULT_CHUNK_SIZE } from '../../src/storage/chunk.js';
import { Table } from '../../src/storage/table.js';
import { createBitmap, setBit, clearBit, testBit, popcount, andBitmaps, orBitmaps, notBitmap } from '../../src/utils/bitmap.js';
import { TempDirectoryManager } from '../../src/storage/temp-directory-manager.js';

describe('Bitmap', () => {
  it('sets and tests bits', async () => {
    const bm = createBitmap(64);
    setBit(bm, 0);
    setBit(bm, 31);
    setBit(bm, 32);
    setBit(bm, 63);
    expect(testBit(bm, 0)).toBe(true);
    expect(testBit(bm, 1)).toBe(false);
    expect(testBit(bm, 31)).toBe(true);
    expect(testBit(bm, 32)).toBe(true);
    expect(testBit(bm, 63)).toBe(true);
  });

  it('clears bits', async () => {
    const bm = createBitmap(32);
    setBit(bm, 5);
    expect(testBit(bm, 5)).toBe(true);
    clearBit(bm, 5);
    expect(testBit(bm, 5)).toBe(false);
  });

  it('counts set bits', async () => {
    const bm = createBitmap(64);
    setBit(bm, 0);
    setBit(bm, 15);
    setBit(bm, 32);
    expect(popcount(bm, 64)).toBe(3);
  });

  it('ANDs bitmaps', async () => {
    const a = createBitmap(32);
    const b = createBitmap(32);
    setBit(a, 0); setBit(a, 1);
    setBit(b, 1); setBit(b, 2);
    const result = andBitmaps(a, b, 32);
    expect(testBit(result, 0)).toBe(false);
    expect(testBit(result, 1)).toBe(true);
    expect(testBit(result, 2)).toBe(false);
  });

  it('ORs bitmaps', async () => {
    const a = createBitmap(32);
    const b = createBitmap(32);
    setBit(a, 0);
    setBit(b, 1);
    const result = orBitmaps(a, b, 32);
    expect(testBit(result, 0)).toBe(true);
    expect(testBit(result, 1)).toBe(true);
  });

  it('NOTs bitmaps', async () => {
    const bm = createBitmap(4);
    setBit(bm, 0);
    const result = notBitmap(bm, 4);
    expect(testBit(result, 0)).toBe(false);
    expect(testBit(result, 1)).toBe(true);
    expect(testBit(result, 2)).toBe(true);
    expect(testBit(result, 3)).toBe(true);
  });
});

describe('Column', () => {
  it('stores and retrieves INT32 values', async () => {
    const col = new Column(DataType.INT32, 10);
    col.set(0, 42);
    col.set(1, -7);
    expect(col.get(0)).toBe(42);
    expect(col.get(1)).toBe(-7);
  });

  it('stores FLOAT64 values', async () => {
    const col = new Column(DataType.FLOAT64, 10);
    col.set(0, 3.14);
    expect(col.get(0)).toBeCloseTo(3.14);
  });

  it('stores DECIMAL as BigInt64', async () => {
    const col = new Column(DataType.DECIMAL, 10);
    col.set(0, 12345n);
    expect(col.get(0)).toBe(12345n);
  });

  it('stores VARCHAR values', async () => {
    const col = new Column(DataType.VARCHAR, 10);
    col.set(0, 'hello');
    col.set(1, 'world');
    expect(col.get(0)).toBe('hello');
    expect(col.get(1)).toBe('world');
  });

  it('handles NULL values', async () => {
    const col = new Column(DataType.INT32, 10);
    col.set(0, 42);
    col.set(1, null);
    expect(col.get(0)).toBe(42);
    expect(col.get(1)).toBeNull();
    expect(col.isNull(1)).toBe(true);
    expect(col.isNull(0)).toBe(false);
  });

  it('appends values', async () => {
    const col = new Column(DataType.INT32, 4);
    col.append(1);
    col.append(2);
    col.append(3);
    expect(col.length).toBe(3);
    expect(col.get(2)).toBe(3);
  });

  it('grows on overflow', async () => {
    const col = new Column(DataType.INT32, 2);
    col.append(1);
    col.append(2);
    col.append(3);
    expect(col.get(2)).toBe(3);
    expect(col.capacity).toBe(4);
  });

  it('stores BOOLEAN values', async () => {
    const col = new Column(DataType.BOOLEAN, 10);
    col.set(0, true);
    col.set(1, false);
    expect(col.get(0)).toBe(true);
    expect(col.get(1)).toBe(false);
  });

  it('slices columns', async () => {
    const col = new Column(DataType.INT32, 10);
    for (let i = 0; i < 5; i++) col.append(i * 10);
    const sliced = col.slice(1, 4);
    expect(sliced.length).toBe(3);
    expect(sliced.get(0)).toBe(10);
    expect(sliced.get(2)).toBe(30);
  });

  it('appendBatch works', async () => {
    const col = new Column(DataType.INT32, 10);
    col.appendBatch([10, 20, 30]);
    expect(col.length).toBe(3);
    expect(col.get(1)).toBe(20);
  });
});

describe('DataChunk', () => {
  it('creates from schema', async () => {
    const schema = [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'name', dataType: DataType.VARCHAR },
    ];
    const chunk = DataChunk.fromSchema(schema);
    expect(chunk.columnCount()).toBe(2);
    expect(chunk.size).toBe(0);
  });

  it('appends and retrieves rows', async () => {
    const schema = [
      { name: 'a', dataType: DataType.INT32 },
      { name: 'b', dataType: DataType.VARCHAR },
    ];
    const chunk = DataChunk.fromSchema(schema);
    chunk.appendRow([1, 'hello']);
    chunk.appendRow([2, 'world']);
    expect(chunk.size).toBe(2);
    expect(chunk.getValue(0, 0)).toBe(1);
    expect(chunk.getValue(1, 1)).toBe('world');
  });

  it('applies selection vector', async () => {
    const schema = [{ name: 'x', dataType: DataType.INT32 }];
    const chunk = DataChunk.fromSchema(schema);
    chunk.appendRow([10]);
    chunk.appendRow([20]);
    chunk.appendRow([30]);
    chunk.setSelectionVector(new Uint32Array([0, 2]), 2);
    expect(chunk.size).toBe(2);
    expect(chunk.getValue(0, 0)).toBe(10);
    expect(chunk.getValue(1, 0)).toBe(30);
  });

  it('projects columns', async () => {
    const schema = [
      { name: 'a', dataType: DataType.INT32 },
      { name: 'b', dataType: DataType.INT32 },
      { name: 'c', dataType: DataType.INT32 },
    ];
    const chunk = DataChunk.fromSchema(schema);
    chunk.appendRow([1, 2, 3]);
    const projected = chunk.project([0, 2]);
    expect(projected.columnCount()).toBe(2);
    expect(projected.getValue(0, 0)).toBe(1);
    expect(projected.getValue(0, 1)).toBe(3);
  });

  it('flattens with selection vector', async () => {
    const schema = [{ name: 'x', dataType: DataType.INT32 }];
    const chunk = DataChunk.fromSchema(schema);
    chunk.appendRow([10]);
    chunk.appendRow([20]);
    chunk.appendRow([30]);
    chunk.setSelectionVector(new Uint32Array([1]), 1);
    const flat = chunk.flatten();
    expect(flat.size).toBe(1);
    expect(flat.getValue(0, 0)).toBe(20);
    expect(flat.selectionVector).toBeNull();
  });

  it('toRows returns array of arrays', async () => {
    const schema = [
      { name: 'a', dataType: DataType.INT32 },
      { name: 'b', dataType: DataType.VARCHAR },
    ];
    const chunk = DataChunk.fromSchema(schema);
    chunk.appendRow([1, 'x']);
    chunk.appendRow([2, 'y']);
    const rows = chunk.toRows();
    expect(rows).toEqual([[1, 'x'], [2, 'y']]);
  });
});

describe('Table', () => {
  let tempManager;

  beforeEach(() => {
    tempManager = new TempDirectoryManager();
  });

  afterEach(() => {
    tempManager.cleanup();
  });

  it('stores and scans rows', async () => {
    const schema = [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'name', dataType: DataType.VARCHAR },
    ];
    const table = new Table('test', schema, tempManager.allocate('buffer', 'test'));
    await table.insertRows([[1, 'alice'], [2, 'bob']]);
    expect(table.rowCount()).toBe(2);

    const chunks = [];
    for await (const chunk of table.scan()) chunks.push(chunk);
    expect(chunks.length).toBe(1);
    expect(chunks[0].getValue(0, 0)).toBe(1);
    expect(chunks[0].getValue(1, 1)).toBe('bob');
  });

  it('splits into multiple chunks when exceeding chunk size', async () => {
    const schema = [{ name: 'x', dataType: DataType.INT32 }];
    const table = new Table('test', schema, tempManager.allocate('buffer', 'test'));
    const rows = Array.from({ length: DEFAULT_CHUNK_SIZE + 100 }, (_, i) => [i]);
    await table.insertRows(rows);
    expect(table.rowCount()).toBe(DEFAULT_CHUNK_SIZE + 100);

    const chunks = [];
    for await (const chunk of table.scan()) chunks.push(chunk);
    expect(chunks.length).toBe(2);
    expect(chunks[0].size).toBe(DEFAULT_CHUNK_SIZE);
    expect(chunks[1].size).toBe(100);
  });

  it('looks up columns by name', async () => {
    const schema = [
      { name: 'ID', dataType: DataType.INT32 },
      { name: 'NAME', dataType: DataType.VARCHAR },
    ];
    const table = new Table('test', schema, tempManager.allocate('buffer', 'test'));
    expect(table.getColumnIndex('id')).toBe(0);
    expect(table.getColumnIndex('name')).toBe(1);
    expect(table.getColumnIndex('missing')).toBe(-1);
  });
});

describe('DataType utilities', () => {
  it('converts dates to epoch days and back', async () => {
    const days = dateToEpochDays(1995, 3, 15);
    const back = epochDaysToDate(days);
    expect(back.year).toBe(1995);
    expect(back.month).toBe(3);
    expect(back.day).toBe(15);
  });

  it('handles epoch correctly', async () => {
    const days = dateToEpochDays(1970, 1, 1);
    expect(days).toBe(0);
  });

  it('handles DECIMAL scale', async () => {
    expect(DECIMAL_SCALE).toBe(100n);
  });
});
