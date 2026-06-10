import { describe, it, expect } from 'vitest';
import { SabArena, heapAllocator } from '../../src/storage/sab-arena.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { ChunkSerializer } from '../../src/storage/serializer.js';
import { DataType } from '../../src/storage/data-type.js';

describe('SabArena', () => {
  it('returns shared, zeroed, aligned views', () => {
    const arena = new SabArena(64);
    arena.acquire(Uint8Array, 3);
    const f = arena.acquire(Float64Array, 4);
    expect(f.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(f.byteOffset % 8).toBe(0);
    expect(Array.from(f)).toEqual([0, 0, 0, 0]);
    arena.acquire(Uint8Array, 5);
    const g = arena.acquire(Float64Array, 2);
    expect(g.byteOffset % 8).toBe(0);
  });

  it('grows by adding segments when a request exceeds remaining space', () => {
    const arena = new SabArena(16);
    arena.acquire(Uint8Array, 10);
    const big = arena.acquire(Float64Array, 1000);
    expect(big.length).toBe(1000);
    expect(arena.segments.length).toBeGreaterThan(1);
    expect(arena.totalBytes()).toBeGreaterThanOrEqual(8000);
  });

  it('never overlaps allocations', () => {
    const arena = new SabArena(256);
    const views = Array.from({ length: 10 }, () => arena.acquire(Int32Array, 8));
    views.forEach((v, i) => v.fill(i + 1));
    views.forEach((v, i) => expect(Array.from(v)).toEqual(new Array(8).fill(i + 1)));
  });
});

const FIXED_CASES = [
  { dataType: DataType.INT32, values: [1, -2, null, 2147483647, 0, null, -7] },
  { dataType: DataType.FLOAT64, values: [1.5, null, -2.25, 0, 1e300, null] },
  { dataType: DataType.BOOLEAN, values: [true, false, null, true] },
  { dataType: DataType.DATE, values: [19000, null, -1, 0] },
  { dataType: DataType.INT64, values: [1n, -9007199254740993n, null, 0n] },
  { dataType: DataType.DECIMAL, values: [12345n, null, -1n] },
  { dataType: DataType.TIMESTAMP, values: [1700000000000n, null, 0n] },
];

function readAll(col, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(col.get(i));
  return out;
}

describe('SAB-backed columns behave identically to heap columns', () => {
  for (const { dataType, values } of FIXED_CASES) {
    it(`${dataType}: set/get/null/append-grow/slice round-trip`, () => {
      const heap = new Column(dataType, 2, heapAllocator);
      const sab = new Column(dataType, 2, new SabArena(64));

      for (const col of [heap, sab]) {
        for (const v of values) col.append(v);
        for (const v of values) col.append(v);
      }

      const total = values.length * 2;
      expect(readAll(sab, total)).toEqual(readAll(heap, total));
      expect(sab.hasNulls).toBe(heap.hasNulls);
      expect(sab.data.buffer).toBeInstanceOf(SharedArrayBuffer);

      const heapSlice = heap.slice(1, total - 1);
      const sabSlice = sab.slice(1, total - 1);
      expect(readAll(sabSlice, total - 2)).toEqual(readAll(heapSlice, total - 2));
      for (let i = 0; i < total - 2; i++) {
        expect(sabSlice.isNull(i)).toBe(heapSlice.isNull(i));
      }
    });
  }

  it('VARCHAR flat column: strings, empties, nulls, growth', () => {
    const values = ['xin chào', '', null, 'a'.repeat(5000), 'mid', null, 'cuối'];
    const heap = new Column(DataType.VARCHAR, 2, heapAllocator);
    const sab = new Column(DataType.VARCHAR, 2, new SabArena(32));
    for (const col of [heap, sab]) for (const v of values) col.append(v);
    expect(readAll(sab, values.length)).toEqual(readAll(heap, values.length));
    expect(sab.stringBytes.buffer).toBeInstanceOf(SharedArrayBuffer);
  });

  it('DictionaryColumn: dedup, nulls, growth, slice', () => {
    const values = [];
    for (let i = 0; i < 5000; i++) values.push(i % 7 === 0 ? null : `v${i % 23}`);
    const heap = new DictionaryColumn(4, heapAllocator);
    const sab = new DictionaryColumn(4, new SabArena(128));
    for (const col of [heap, sab]) for (const v of values) col.append(v);
    expect(readAll(sab, values.length)).toEqual(readAll(heap, values.length));
    expect(sab.indices.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(readAll(sab.slice(100, 200), 100)).toEqual(readAll(heap.slice(100, 200), 100));
  });
});

describe('ChunkSerializer with SAB allocator', () => {
  function buildChunk() {
    const ints = new Column(DataType.INT32, 8);
    const floats = new Column(DataType.FLOAT64, 8);
    const strings = new Column(DataType.VARCHAR, 8);
    const dict = new DictionaryColumn(8);
    const rows = [
      [1, 1.5, 'alpha', 'x'],
      [null, null, null, null],
      [3, -2.25, '', 'y'],
      [4, 0, 'beta', 'x'],
    ];
    for (const [a, b, c, d] of rows) {
      ints.append(a); floats.append(b); strings.append(c); dict.append(d);
    }
    return new DataChunk([ints, floats, strings, dict], rows.length);
  }

  it('deserialize into arena matches heap deserialize and survives re-serialization', () => {
    const buffer = ChunkSerializer.serialize(buildChunk());
    const heapChunk = ChunkSerializer.deserialize(buffer);
    const sabChunk = ChunkSerializer.deserialize(buffer, new SabArena(buffer.length));

    expect(sabChunk.toRows()).toEqual(heapChunk.toRows());
    expect(sabChunk.columns[0].data.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(sabChunk.columns[2].stringBytes.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(sabChunk.columns[3].indices.buffer).toBeInstanceOf(SharedArrayBuffer);

    const reserialized = ChunkSerializer.serialize(sabChunk);
    expect(ChunkSerializer.deserialize(reserialized).toRows()).toEqual(heapChunk.toRows());
  });
});
