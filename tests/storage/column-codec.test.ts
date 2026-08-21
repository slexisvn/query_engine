import { describe, it, expect, afterEach } from 'vitest';
import {
  ColumnForm, columnFormOf, columnRecordBytes, columnRetainedBytes,
  readColumnRecord, writeColumnRecord,
} from '../../src/storage/column-codec.js';
import { ByteReader, ByteWriter } from '../../src/storage/encoding/byte-io.js';
import { encodeChunkColumns } from '../../src/storage/encoding/column-encoding.js';
import { EncodingKind } from '../../src/storage/encoding/encoding-types.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataType } from '../../src/storage/data-type.js';
import { SabArena } from '../../src/storage/sab-arena.js';
import { Config } from '../../src/config.js';
import { columnOf, columnValues, repeatRuns } from '../helpers/encoding-fixtures.js';

const ROWS = 128;

const savedForced = Config.forcedColumnEncoding;
afterEach(() => { Config.forcedColumnEncoding = savedForced; });

function roundTrip(column, allocator = undefined) {
  const size = columnRecordBytes(column);
  const buffer = Buffer.alloc(size);
  const writer = new ByteWriter(buffer);
  writeColumnRecord(writer, column);

  const reader = new ByteReader(buffer, 0, allocator);
  const restored = readColumnRecord(reader);
  return { restored, size, written: writer.offset, consumed: reader.offset };
}

function encodedColumn(kind, values, dataType = DataType.INT32) {
  Config.forcedColumnEncoding = kind;
  try {
    return encodeChunkColumns(new DataChunk([columnOf(dataType, values)], values.length)).columns[0];
  } finally {
    Config.forcedColumnEncoding = savedForced;
  }
}

describe('column record codec', () => {
  describe('form dispatch', () => {
    it('classifies a fixed-width column as flat', () => {
      expect(columnFormOf(columnOf(DataType.INT32, [1, 2]))).toBe(ColumnForm.FLAT);
    });

    it('classifies a varchar column as flat', () => {
      expect(columnFormOf(columnOf(DataType.VARCHAR, ['a']))).toBe(ColumnForm.FLAT);
    });

    it('classifies a dictionary column as dictionary', () => {
      const dictionary = new DictionaryColumn(4);
      dictionary.set(0, 'a');
      expect(columnFormOf(dictionary)).toBe(ColumnForm.DICTIONARY);
    });

    it('classifies an encoded column as encoded', () => {
      const column = encodedColumn(EncodingKind.RUN_LENGTH, repeatRuns(8, [1, 2]));
      expect(columnFormOf(column)).toBe(ColumnForm.ENCODED);
    });

    it('reclassifies an encoded column as flat once it has been decoded', () => {
      const column = encodedColumn(EncodingKind.RUN_LENGTH, repeatRuns(8, [1, 2]));
      void column.data;
      expect(columnFormOf(column)).toBe(ColumnForm.FLAT);
    });
  });

  describe('record size', () => {
    it('reports exactly the bytes written for every form', () => {
      const dictionary = new DictionaryColumn(4);
      ['x', 'yy', 'x', ''].forEach((value, i) => dictionary.set(i, value));

      const columns = [
        columnOf(DataType.INT32, [1, 2, 3]),
        columnOf(DataType.VARCHAR, ['a', 'bb', null]),
        columnOf(DataType.INT64, [1n, null, 3n]),
        dictionary,
        encodedColumn(EncodingKind.RUN_LENGTH, repeatRuns(8, [1, 2])),
        encodedColumn(EncodingKind.BIT_PACKED, Array.from({ length: 64 }, (_, i) => i % 9)),
        encodedColumn(EncodingKind.FRAME_OF_REFERENCE, Array.from({ length: 64 }, (_, i) => -900 + i)),
      ];

      for (const column of columns) {
        const { size, written, consumed } = roundTrip(column);
        expect(written).toBe(size);
        expect(consumed).toBe(size);
      }
    });
  });

  describe('round-trip', () => {
    it('restores a flat fixed-width column with nulls', () => {
      const values = [1, null, 3, null, 5];
      const { restored } = roundTrip(columnOf(DataType.INT32, values));

      expect(restored.hasNulls).toBe(true);
      expect(columnValues(restored, values.length)).toEqual(values);
    });

    it('restores a varchar column with an empty string and a null', () => {
      const values = ['alpha', '', null, 'δ'];
      const { restored } = roundTrip(columnOf(DataType.VARCHAR, values));

      expect(columnValues(restored, values.length)).toEqual(values);
    });

    it('restores a dictionary column with its dictionary intact', () => {
      const dictionary = new DictionaryColumn(4);
      ['red', 'blue', 'red', null].forEach((value, i) => dictionary.set(i, value));
      const { restored } = roundTrip(dictionary);

      expect(restored).toBeInstanceOf(DictionaryColumn);
      expect(columnValues(restored, 4)).toEqual(['red', 'blue', 'red', null]);
      expect(restored.reverseDict).toEqual(['red', 'blue']);
    });

    it('restores an empty column', () => {
      const { restored } = roundTrip(new Column(DataType.INT32, 4));

      expect(restored.length).toBe(0);
      expect(restored.hasNulls).toBe(false);
    });

    it('restores each encoding still encoded and still exact', () => {
      const cases = [
        [EncodingKind.RUN_LENGTH, repeatRuns(16, [7, 7, -3, 0]), DataType.INT32],
        [EncodingKind.BIT_PACKED, Array.from({ length: ROWS }, (_, i) => i % 37), DataType.INT32],
        [EncodingKind.FRAME_OF_REFERENCE, Array.from({ length: ROWS }, (_, i) => -50000 + i), DataType.INT32],
        [EncodingKind.RUN_LENGTH, repeatRuns(16, [7n, -3n]), DataType.INT64],
        [EncodingKind.BIT_PACKED, Array.from({ length: ROWS }, (_, i) => BigInt(i % 37)), DataType.INT64],
        [EncodingKind.FRAME_OF_REFERENCE, Array.from({ length: ROWS }, (_, i) => 1700000000000n + BigInt(i)), DataType.INT64],
      ];

      for (const [kind, values, dataType] of cases) {
        const column = encodedColumn(kind, values, dataType);
        const { restored } = roundTrip(column);

        expect(restored.encoded.kind).toBe(kind);
        expect(columnValues(restored, values.length)).toEqual(values);
      }
    });

    it('restores nulls that sit inside an encoded run', () => {
      const values = repeatRuns(16, [5, 9]).map((value, i) => (i % 5 === 0 ? null : value));
      const column = encodedColumn(EncodingKind.RUN_LENGTH, values);
      const { restored } = roundTrip(column);

      expect(restored.encoded.kind).toBe(EncodingKind.RUN_LENGTH);
      expect(columnValues(restored, values.length)).toEqual(values);
    });

    it('restores an all-null encoded column', () => {
      const values = new Array(ROWS).fill(null);
      const { restored } = roundTrip(encodedColumn(EncodingKind.RUN_LENGTH, values));

      expect(columnValues(restored, ROWS)).toEqual(values);
    });

    it('restores an encoded column into a shared arena when one is given', () => {
      const values = Array.from({ length: ROWS }, (_, i) => -50000 + i);
      const column = encodedColumn(EncodingKind.FRAME_OF_REFERENCE, values);
      const { restored } = roundTrip(column, new SabArena(4096));

      expect(restored.encoded.offsets.buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(columnValues(restored, values.length)).toEqual(values);
    });
  });

  describe('retained bytes', () => {
    it('counts an encoded column as smaller than the flat column it replaced', () => {
      const flat = columnOf(DataType.INT32, repeatRuns(64, [1, 2]));
      const encoded = encodedColumn(EncodingKind.RUN_LENGTH, repeatRuns(64, [1, 2]));

      expect(columnRetainedBytes(encoded)).toBeLessThan(columnRetainedBytes(flat));
    });

    it('counts dictionary payload bytes rather than the index array alone', () => {
      const dictionary = new DictionaryColumn(4);
      ['aaaaaaaaaa', 'bbbbbbbbbb'].forEach((value, i) => dictionary.set(i, value));

      expect(columnRetainedBytes(dictionary)).toBeGreaterThan(dictionary.indices.byteLength);
    });
  });

  describe('corrupt input', () => {
    it('rejects an unknown column form', () => {
      const buffer = Buffer.alloc(8);
      buffer.writeUInt8(9, 0);
      expect(() => readColumnRecord(new ByteReader(buffer))).toThrow(/Unknown column form/);
    });

    it('rejects an unknown data type id', () => {
      const buffer = Buffer.alloc(8);
      buffer.writeUInt8(0, 0);
      buffer.writeUInt8(99, 1);
      expect(() => readColumnRecord(new ByteReader(buffer))).toThrow(/Unknown column data type id/);
    });
  });
});
