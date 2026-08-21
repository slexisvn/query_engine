import { describe, it, expect, afterEach } from 'vitest';
import { chooseEncoder, encodeChunkColumns, encodeColumnValues } from '../../../src/storage/encoding/column-encoding.js';
import { EncodingKind } from '../../../src/storage/encoding/encoding-types.js';
import { summarizeIntegers } from '../../../src/storage/encoding/integer-values.js';
import { columnRetainedBytes } from '../../../src/storage/column-codec.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DictionaryColumn } from '../../../src/storage/dictionary-column.js';
import { DataType } from '../../../src/storage/data-type.js';
import { Config } from '../../../src/config.js';
import { columnOf, columnValues, repeatRuns, sourceOf } from '../../helpers/encoding-fixtures.js';

const ROWS = 128;

const savedConfig = {
  columnEncoding: Config.columnEncoding,
  forcedColumnEncoding: Config.forcedColumnEncoding,
  encodingMinRows: Config.encodingMinRows,
  encodingMinCompressionRatio: Config.encodingMinCompressionRatio,
};

afterEach(() => {
  Object.assign(Config, savedConfig);
});

function kindFor(dataType, values) {
  const stats = sourceOf(dataType, values).stats;
  const encoder = chooseEncoder(stats, dataType);
  return encoder === null ? null : encoder.kind;
}

function runHeavy() {
  return repeatRuns(ROWS / 2, [1000000, 2000000]);
}

function narrowNonNegative() {
  return Array.from({ length: ROWS }, (_, i) => i % 16);
}

function negativeBand() {
  return Array.from({ length: ROWS }, (_, i) => -1000 + (i % 251));
}

function farAnchoredWide() {
  return Array.from({ length: ROWS }, (_, i) => 1700000000000n + BigInt(i % 1000));
}

describe('column encoding selection', () => {
  describe('data shape decides the encoding', () => {
    it('picks run-length for a column made of long runs', () => {
      expect(kindFor(DataType.INT32, runHeavy())).toBe(EncodingKind.RUN_LENGTH);
    });

    it('picks bit-packing for a narrow non-negative range with no runs', () => {
      expect(kindFor(DataType.INT32, narrowNonNegative())).toBe(EncodingKind.BIT_PACKED);
    });

    it('picks frame-of-reference for a narrow band that bit-packing cannot take', () => {
      expect(kindFor(DataType.INT32, negativeBand())).toBe(EncodingKind.FRAME_OF_REFERENCE);
    });

    it('picks frame-of-reference for INT64 values anchored far from zero', () => {
      expect(kindFor(DataType.INT64, farAnchoredWide())).toBe(EncodingKind.FRAME_OF_REFERENCE);
    });

    it('takes the smallest candidate when run-length and bit-packing both fit', () => {
      const shortRuns = repeatRuns(2, Array.from({ length: ROWS / 2 }, (_, i) => i % 64));

      expect(kindFor(DataType.INT32, shortRuns)).toBe(EncodingKind.BIT_PACKED);
    });

    it('takes the smallest candidate when frame-of-reference beats bit-packing', () => {
      const highAnchored = Array.from({ length: ROWS }, (_, i) => 1000 + (i % 251));

      expect(kindFor(DataType.INT32, highAnchored)).toBe(EncodingKind.FRAME_OF_REFERENCE);
    });

    it('leaves a column flat when nothing beats the compression ratio', () => {
      const spread = Array.from({ length: ROWS }, (_, i) => (i % 2 === 0 ? -2000000000 : 2000000000 - i));
      expect(kindFor(DataType.INT32, spread)).toBeNull();
    });
  });

  describe('configuration gates', () => {
    it('encodes nothing when column encoding is switched off', () => {
      Config.columnEncoding = false;
      expect(encodeColumnValues(columnOf(DataType.INT32, runHeavy()))).toBeNull();
    });

    it('leaves short columns flat under the minimum row count', () => {
      Config.encodingMinRows = 1000;
      expect(kindFor(DataType.INT32, runHeavy())).toBeNull();
    });

    it('refuses an encoding that does not beat the minimum compression ratio', () => {
      Config.encodingMinCompressionRatio = 0.001;
      expect(kindFor(DataType.INT32, runHeavy())).toBeNull();
    });

    it('uses the forced encoding even where selection would pick another', () => {
      Config.forcedColumnEncoding = EncodingKind.BIT_PACKED;
      expect(kindFor(DataType.INT32, runHeavy())).toBe(EncodingKind.BIT_PACKED);
    });

    it('uses the forced encoding even below the minimum row count', () => {
      Config.forcedColumnEncoding = EncodingKind.RUN_LENGTH;
      Config.encodingMinRows = 1000;
      expect(kindFor(DataType.INT32, [4, 4, 4])).toBe(EncodingKind.RUN_LENGTH);
    });

    it('falls back to flat when the forced encoding cannot represent the data', () => {
      Config.forcedColumnEncoding = EncodingKind.BIT_PACKED;
      expect(kindFor(DataType.INT32, negativeBand())).toBeNull();
    });

    it('falls back to flat when the forced encoding name is unknown', () => {
      Config.forcedColumnEncoding = 'NOT_AN_ENCODING';
      expect(kindFor(DataType.INT32, runHeavy())).toBeNull();
    });
  });

  describe('columns that are not encoded', () => {
    it('leaves every non-integer type alone', () => {
      const cases = [
        [DataType.FLOAT64, Array.from({ length: ROWS }, () => 1.5)],
        [DataType.BOOLEAN, Array.from({ length: ROWS }, () => true)],
        [DataType.DECIMAL, Array.from({ length: ROWS }, () => 2.5)],
        [DataType.DATE, Array.from({ length: ROWS }, () => 19000)],
        [DataType.TIMESTAMP, Array.from({ length: ROWS }, () => 1700000000000n)],
      ];

      for (const [dataType, values] of cases) {
        expect(encodeColumnValues(columnOf(dataType, values))).toBeNull();
      }
    });

    it('leaves an empty column alone', () => {
      expect(encodeColumnValues(new Column(DataType.INT32, 8))).toBeNull();
    });

    it('leaves a dictionary column alone', () => {
      const dictionary = new DictionaryColumn(ROWS);
      for (let i = 0; i < ROWS; i++) dictionary.set(i, 'a');
      const chunk = new DataChunk([dictionary], ROWS);

      expect(encodeChunkColumns(chunk)).toBe(chunk);
    });
  });

  describe('encoded chunks', () => {
    it('returns the same chunk when no column is worth encoding', () => {
      const chunk = new DataChunk([columnOf(DataType.FLOAT64, [1.5, 2.5])], 2);
      expect(encodeChunkColumns(chunk)).toBe(chunk);
    });

    it('replaces only the columns that were encoded', () => {
      const encodable = columnOf(DataType.INT32, runHeavy());
      const plain = columnOf(DataType.FLOAT64, Array.from({ length: ROWS }, (_, i) => i / 3));
      const encoded = encodeChunkColumns(new DataChunk([encodable, plain], ROWS));

      expect(encoded.columns[0].encoded.kind).toBe(EncodingKind.RUN_LENGTH);
      expect(encoded.columns[1]).toBe(plain);
    });

    it('keeps every value and every null across encoding', () => {
      const values = runHeavy().map((value, i) => (i % 7 === 0 ? null : value));
      const chunk = new DataChunk([columnOf(DataType.INT32, values)], ROWS);
      const encoded = encodeChunkColumns(chunk);

      expect(encoded.columns[0].encoded).not.toBeNull();
      expect(columnValues(encoded.columns[0], ROWS)).toEqual(values);
    });

    it('keeps an all-null column readable as all null', () => {
      const values = new Array(ROWS).fill(null);
      const encoded = encodeChunkColumns(new DataChunk([columnOf(DataType.INT32, values)], ROWS));

      expect(encoded.columns[0].encoded).not.toBeNull();
      expect(columnValues(encoded.columns[0], ROWS)).toEqual(values);
    });

    it('resolves a selection vector to the rows it selects', () => {
      const values = runHeavy();
      const chunk = new DataChunk([columnOf(DataType.INT32, values)], ROWS);
      chunk.setSelectionVector(Uint32Array.from([ROWS - 1, 0, 5]), 3);

      const encoded = encodeChunkColumns(chunk);

      expect(encoded.selectionVector).toBeNull();
      expect(encoded.size).toBe(3);
      expect(columnValues(encoded.columns[0], 3)).toEqual([values[ROWS - 1], values[0], values[5]]);
    });

    it('leaves the source chunk untouched', () => {
      const source = columnOf(DataType.INT32, runHeavy());
      const chunk = new DataChunk([source], ROWS);

      encodeChunkColumns(chunk);

      expect(chunk.columns[0]).toBe(source);
      expect(source.encoded).toBeNull();
    });
  });

  describe('memory footprint', () => {
    it('shrinks a run-heavy column by more than an order of magnitude', () => {
      const flat = columnOf(DataType.INT32, runHeavy());
      const encoded = encodeChunkColumns(new DataChunk([flat], ROWS)).columns[0];

      expect(columnRetainedBytes(encoded)).toBeLessThan(columnRetainedBytes(flat) / 10);
    });

    it('shrinks a narrow non-negative column below the flat width', () => {
      const flat = columnOf(DataType.INT32, narrowNonNegative());
      const encoded = encodeChunkColumns(new DataChunk([flat], ROWS)).columns[0];

      expect(columnRetainedBytes(encoded)).toBeLessThan(columnRetainedBytes(flat) / 2);
    });
  });

  describe('decoding on demand', () => {
    it('materializes the flat array and drops the encoded form when data is read', () => {
      const values = runHeavy();
      const encoded = encodeChunkColumns(new DataChunk([columnOf(DataType.INT32, values)], ROWS)).columns[0];

      expect(encoded.encoded).not.toBeNull();
      expect(Array.from(encoded.data)).toEqual(values);
      expect(encoded.encoded).toBeNull();
      expect(columnValues(encoded, ROWS)).toEqual(values);
    });

    it('leaves the source column encoded when a scan view is materialized', () => {
      const encoded = encodeChunkColumns(new DataChunk([columnOf(DataType.INT32, runHeavy())], ROWS)).columns[0];
      const view = encoded.scanView();

      expect(Array.from(view.data)).toEqual(runHeavy());
      expect(view.encoded).toBeNull();
      expect(encoded.encoded).not.toBeNull();
    });

    it('flattens the column when a value is written into it', () => {
      const encoded = encodeChunkColumns(new DataChunk([columnOf(DataType.INT32, runHeavy())], ROWS)).columns[0];

      encoded.set(3, 77);

      expect(encoded.encoded).toBeNull();
      expect(encoded.get(3)).toBe(77);
      expect(encoded.get(4)).toBe(1000000);
    });
  });

  describe('statistics', () => {
    it('summarizes range and run count in one pass over INT32 values', () => {
      const stats = summarizeIntegers(Int32Array.from([5, 5, -2, -2, -2, 9]), 6);
      expect(stats).toEqual({ length: 6, runCount: 3, min: -2n, max: 9n });
    });

    it('summarizes INT64 values without losing precision', () => {
      const stats = summarizeIntegers(BigInt64Array.from([9007199254740993n, -9007199254740993n]), 2);
      expect(stats.min).toBe(-9007199254740993n);
      expect(stats.max).toBe(9007199254740993n);
    });
  });
});
