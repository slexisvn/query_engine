import { describe, it, expect } from 'vitest';
import { shareChunk, encodeChunkSet, transportBytes, ChunkSetReader } from '../../src/parallel/chunk-transport.js';
import { SabArena } from '../../src/storage/sab-arena.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { DataType } from '../../src/storage/data-type.js';

function mixedChunk(rows) {
  const ints = new Column(DataType.INT32, rows.length);
  const floats = new Column(DataType.FLOAT64, rows.length);
  const strings = new Column(DataType.VARCHAR, rows.length);
  const dict = new DictionaryColumn(rows.length);
  const bigs = new Column(DataType.INT64, rows.length);
  rows.forEach(([a, b, c, d, e], i) => {
    ints.set(i, a); floats.set(i, b); strings.set(i, c); dict.set(i, d); bigs.set(i, e);
  });
  for (const col of [ints, floats, strings, bigs]) col.length = rows.length;
  dict.length = rows.length;
  return new DataChunk([ints, floats, strings, dict, bigs], rows.length);
}

const ROWS = [
  [1, 1.5, 'alpha', 'x', 10n],
  [null, null, null, null, null],
  [-3, 2.25, '', 'y', -7n],
  [4, 0, 'beta', 'x', 0n],
];
const ALL = [0, 1, 2, 3, 4];

describe('encodeChunkSet / ChunkSetReader', () => {
  it('round-trips every column kind through shared buffers', () => {
    const arena = new SabArena();
    const shared = [shareChunk(mixedChunk(ROWS), ALL, arena), shareChunk(mixedChunk(ROWS.slice(0, 2)), ALL, arena)];
    const encoded = encodeChunkSet(shared, ALL, arena);

    const reader = new ChunkSetReader(encoded);
    expect(reader.count).toBe(2);
    expect(reader.chunk(0).toRows()).toEqual(shared[0].toRows());
    expect(reader.chunk(1).toRows()).toEqual(shared[1].toRows());
  });

  it('caches decoded chunks by index', () => {
    const arena = new SabArena();
    const shared = [shareChunk(mixedChunk(ROWS), ALL, arena)];
    const reader = new ChunkSetReader(encodeChunkSet(shared, ALL, arena));
    expect(reader.chunk(0)).toBe(reader.chunk(0));
  });

  it('encodes only the requested columns', () => {
    const arena = new SabArena();
    const shared = [shareChunk(mixedChunk(ROWS), [0, 3], arena)];
    const reader = new ChunkSetReader(encodeChunkSet(shared, [0, 3], arena));
    const chunk = reader.chunk(0);
    expect(chunk.columns.length).toBe(2);
    expect(chunk.toRows()).toEqual(ROWS.map(r => [r[0], r[3]]));
  });

  it('deduplicates buffers so identical chunks add no transport bytes', () => {
    const arena = new SabArena();
    const shared = shareChunk(mixedChunk(ROWS), ALL, arena);
    const once = transportBytes(encodeChunkSet([shared], ALL, new SabArena()));
    const twice = transportBytes(encodeChunkSet([shared, shared], ALL, new SabArena()));
    expect(twice).toBe(once);
  });
});

describe('shareChunk', () => {
  it('copies heap-backed columns into the arena without touching the source', () => {
    const source = mixedChunk(ROWS);
    const arena = new SabArena();
    const shared = shareChunk(source, ALL, arena);
    expect(shared).not.toBe(source);
    expect(shared.columns[0].data.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(source.columns[0].data.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    expect(shared.toRows()).toEqual(source.toRows());
  });

  it('returns the same chunk when already shared, and recopies under forceCopy', () => {
    const arena = new SabArena();
    const shared = shareChunk(mixedChunk(ROWS), ALL, arena);
    expect(shareChunk(shared, ALL, arena)).toBe(shared);

    const forced = shareChunk(shared, ALL, arena, true);
    expect(forced).not.toBe(shared);
    expect(forced.columns[0].data).not.toBe(shared.columns[0].data);
    expect(forced.toRows()).toEqual(shared.toRows());
  });

  it('flattens selection vectors before sharing', () => {
    const source = mixedChunk(ROWS);
    source.setSelectionVector(new Uint32Array([0, 2]), 2);
    const shared = shareChunk(source, ALL, new SabArena());
    expect(shared.selectionVector).toBeNull();
    expect(shared.size).toBe(2);
    expect(shared.getValue(1, 0)).toBe(-3);
  });
});
