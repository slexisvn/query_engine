import { describe, it, expect } from 'vitest';
import { ChunkCodec } from '../../../src/distributed/transport/chunk-codec.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DictionaryColumn } from '../../../src/storage/dictionary-column.js';
import { DataType } from '../../../src/storage/data-type.js';

function makeChunk(colDefs, rows) {
  const columns = colDefs.map(def => {
    if (def.type === DataType.VARCHAR && def.dictionary) {
      return new DictionaryColumn(rows.length);
    }
    return new Column(def.type, rows.length);
  });

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < colDefs.length; c++) {
      columns[c].set(r, rows[r][c]);
    }
    columns.forEach(col => { if (r >= col.length) col.length = r + 1; });
  }

  for (const col of columns) col.length = rows.length;
  return new DataChunk(columns, rows.length);
}

describe('ChunkCodec', () => {
  const codec = new ChunkCodec();

  it('roundtrips INT32 columns', () => {
    const chunk = makeChunk(
      [{ type: DataType.INT32 }],
      [[1], [2], [3], [42]]
    );
    const encoded = codec.encode(chunk);
    const decoded = codec.decode(encoded);

    expect(decoded.size).toBe(4);
    expect(decoded.columns[0].get(0)).toBe(1);
    expect(decoded.columns[0].get(3)).toBe(42);
  });

  it('roundtrips FLOAT64 columns', () => {
    const chunk = makeChunk(
      [{ type: DataType.FLOAT64 }],
      [[1.5], [2.7], [3.14]]
    );
    const decoded = codec.decode(codec.encode(chunk));

    expect(decoded.size).toBe(3);
    expect(decoded.columns[0].get(0)).toBeCloseTo(1.5);
    expect(decoded.columns[0].get(2)).toBeCloseTo(3.14);
  });

  it('roundtrips INT64 columns', () => {
    const chunk = makeChunk(
      [{ type: DataType.INT64 }],
      [[100n], [200n], [9007199254740993n]]
    );
    const decoded = codec.decode(codec.encode(chunk));

    expect(decoded.size).toBe(3);
    expect(decoded.columns[0].get(0)).toBe(100n);
    expect(decoded.columns[0].get(2)).toBe(9007199254740993n);
  });

  it('roundtrips VARCHAR columns', () => {
    const chunk = makeChunk(
      [{ type: DataType.VARCHAR }],
      [['hello'], ['world'], ['foo bar']]
    );
    const decoded = codec.decode(codec.encode(chunk));

    expect(decoded.size).toBe(3);
    expect(decoded.columns[0].get(0)).toBe('hello');
    expect(decoded.columns[0].get(2)).toBe('foo bar');
  });

  it('roundtrips DictionaryColumn', () => {
    const chunk = makeChunk(
      [{ type: DataType.VARCHAR, dictionary: true }],
      [['apple'], ['banana'], ['apple'], ['cherry']]
    );
    const decoded = codec.decode(codec.encode(chunk));

    expect(decoded.size).toBe(4);
    expect(decoded.columns[0].get(0)).toBe('apple');
    expect(decoded.columns[0].get(1)).toBe('banana');
    expect(decoded.columns[0].get(2)).toBe('apple');
    expect(decoded.columns[0].get(3)).toBe('cherry');
  });

  it('roundtrips multi-column chunks', () => {
    const chunk = makeChunk(
      [{ type: DataType.INT32 }, { type: DataType.VARCHAR }, { type: DataType.FLOAT64 }],
      [[1, 'a', 1.1], [2, 'b', 2.2], [3, 'c', 3.3]]
    );
    const decoded = codec.decode(codec.encode(chunk));

    expect(decoded.size).toBe(3);
    expect(decoded.columns[0].get(1)).toBe(2);
    expect(decoded.columns[1].get(1)).toBe('b');
    expect(decoded.columns[2].get(1)).toBeCloseTo(2.2);
  });

  it('handles null values', () => {
    const chunk = makeChunk(
      [{ type: DataType.INT32 }, { type: DataType.VARCHAR }],
      [[1, 'a'], [null, 'b'], [3, null]]
    );
    const decoded = codec.decode(codec.encode(chunk));

    expect(decoded.columns[0].get(0)).toBe(1);
    expect(decoded.columns[0].get(1)).toBe(null);
    expect(decoded.columns[1].get(2)).toBe(null);
  });

  it('handles empty chunk', () => {
    const chunk = new DataChunk([], 0);
    const decoded = codec.decode(codec.encode(chunk));
    expect(decoded.size).toBe(0);
    expect(decoded.columns.length).toBe(0);
  });

  it('roundtrips BOOLEAN columns', () => {
    const chunk = makeChunk(
      [{ type: DataType.BOOLEAN }],
      [[true], [false], [true]]
    );
    const decoded = codec.decode(codec.encode(chunk));

    expect(decoded.size).toBe(3);
    expect(decoded.columns[0].get(0)).toBe(true);
    expect(decoded.columns[0].get(1)).toBe(false);
  });

  it('roundtrips DATE columns', () => {
    const chunk = makeChunk(
      [{ type: DataType.DATE }],
      [[19000], [19500], [20000]]
    );
    const decoded = codec.decode(codec.encode(chunk));

    expect(decoded.size).toBe(3);
    expect(decoded.columns[0].get(0)).toBe(19000);
    expect(decoded.columns[0].get(2)).toBe(20000);
  });

  it('handles chunks with selection vectors by flattening', () => {
    const col = new Column(DataType.INT32, 5);
    for (let i = 0; i < 5; i++) col.set(i, i * 10);
    col.length = 5;

    const chunk = new DataChunk([col], 5);
    chunk.setSelectionVector(new Uint32Array([1, 3]), 2);

    const decoded = codec.decode(codec.encode(chunk));
    expect(decoded.size).toBe(2);
    expect(decoded.columns[0].get(0)).toBe(10);
    expect(decoded.columns[0].get(1)).toBe(30);
  });

  it('rejects invalid magic number', () => {
    const buf = Buffer.alloc(20);
    buf.writeUInt32LE(0xDEADBEEF, 0);
    expect(() => codec.decode(buf)).toThrow('Invalid chunk codec magic number');
  });
});
