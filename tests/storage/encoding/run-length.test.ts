import { describe, it, expect } from 'vitest';
import { runLengthEncoder } from '../../../src/storage/encoding/run-length.js';
import { DataType } from '../../../src/storage/data-type.js';
import { Config } from '../../../src/config.js';
import {
  INT32_MAX, INT32_MIN, INT64_MAX, INT64_MIN,
  columnOf, integerArrayOf, readBack, repeatRuns, roundTripVector, sourceOf,
} from '../../helpers/encoding-fixtures.js';

function encode(dataType, values) {
  return runLengthEncoder.encode(sourceOf(dataType, values));
}

describe('run-length encoding', () => {
  describe('value round-trip', () => {
    it('reads back every index of a multi-run INT32 column', () => {
      const values = repeatRuns(7, [4, 4, -1, 0, 99]);
      const vector = encode(DataType.INT32, values);

      expect(readBack(vector)).toEqual(values);
      expect(Array.from(vector.decode())).toEqual(values);
    });

    it('reads back every index of a multi-run INT64 column', () => {
      const values = repeatRuns(5, [1n, 1n, -8n, 1234567890123n]);
      const vector = encode(DataType.INT64, values);

      expect(readBack(vector)).toEqual(values);
      expect(Array.from(vector.decode())).toEqual(values);
    });

    it('collapses adjacent equal runs into one run', () => {
      const vector = encode(DataType.INT32, repeatRuns(4, [3, 3, 3]));

      expect(vector.runCount).toBe(1);
      expect(readBack(vector)).toEqual(new Array(12).fill(3));
    });

    it('survives the worst case where no two neighbours are equal', () => {
      const values = Array.from({ length: 64 }, (_, i) => i * 3 - 90);
      const vector = encode(DataType.INT32, values);

      expect(vector.runCount).toBe(64);
      expect(readBack(vector)).toEqual(values);
    });

    it('handles a single-value column', () => {
      const vector = encode(DataType.INT32, [7]);

      expect(vector.runCount).toBe(1);
      expect(vector.valueAt(0)).toBe(7);
      expect(Array.from(vector.decode())).toEqual([7]);
    });

    it('keeps the type range boundaries exact', () => {
      const int32 = encode(DataType.INT32, [INT32_MIN, INT32_MIN, INT32_MAX, 0]);
      const int64 = encode(DataType.INT64, [INT64_MIN, INT64_MAX, INT64_MAX]);

      expect(readBack(int32)).toEqual([INT32_MIN, INT32_MIN, INT32_MAX, 0]);
      expect(readBack(int64)).toEqual([INT64_MIN, INT64_MAX, INT64_MAX]);
    });
  });

  describe('run index lookup', () => {
    it('lands on the right run at every boundary of an uneven layout', () => {
      const values = [5, 5, 5, 8, 1, 1, 1, 1, 4];
      const vector = encode(DataType.INT32, values);

      expect(vector.runCount).toBe(4);
      for (let i = 0; i < values.length; i++) {
        expect(vector.valueAt(i)).toBe(values[i]);
      }
    });

    it('finds the last run of a long column without scanning linearly', () => {
      const values = repeatRuns(64, Array.from({ length: 32 }, (_, i) => i));
      const vector = encode(DataType.INT32, values);

      expect(vector.valueAt(values.length - 1)).toBe(31);
      expect(vector.valueAt(0)).toBe(0);
      expect(vector.valueAt(64)).toBe(1);
      expect(vector.valueAt(63)).toBe(0);
    });
  });

  describe('serialization', () => {
    it('writes exactly the bytes it reports and restores the same values', () => {
      const values = repeatRuns(9, [2, 2, -5, 400000]);
      const vector = encode(DataType.INT32, values);
      const { restored, written, consumed } = roundTripVector(runLengthEncoder, vector);

      expect(written).toBe(vector.byteSize());
      expect(consumed).toBe(vector.byteSize());
      expect(readBack(restored)).toEqual(values);
    });

    it('restores INT64 run values without narrowing them', () => {
      const values = repeatRuns(3, [INT64_MAX, INT64_MIN, 0n]);
      const { restored } = roundTripVector(runLengthEncoder, encode(DataType.INT64, values));

      expect(readBack(restored)).toEqual(values);
    });
  });

  describe('planning', () => {
    it('accepts a column whose run count is under the configured ratio', () => {
      const saved = Config.encodingRleMaxRunRatio;
      Config.encodingRleMaxRunRatio = 0.5;
      try {
        const source = sourceOf(DataType.INT32, repeatRuns(10, [1, 2, 3, 4]));
        expect(runLengthEncoder.plan(source.stats, DataType.INT32).withinThreshold).toBe(true);
      } finally {
        Config.encodingRleMaxRunRatio = saved;
      }
    });

    it('refuses a column whose run count is over the configured ratio', () => {
      const saved = Config.encodingRleMaxRunRatio;
      Config.encodingRleMaxRunRatio = 0.5;
      try {
        const source = sourceOf(DataType.INT32, Array.from({ length: 40 }, (_, i) => i));
        expect(runLengthEncoder.plan(source.stats, DataType.INT32).withinThreshold).toBe(false);
      } finally {
        Config.encodingRleMaxRunRatio = saved;
      }
    });

    it('estimates the byte size the encoded vector actually occupies', () => {
      const source = sourceOf(DataType.INT64, repeatRuns(8, [1n, 2n, 3n]));
      const plan = runLengthEncoder.plan(source.stats, DataType.INT64);

      expect(plan.bytes).toBe(runLengthEncoder.encode(source).byteSize());
    });
  });

  describe('null handling', () => {
    it('reports null through the column even when the run covers the null slot', () => {
      const column = columnOf(DataType.INT32, [6, null, 6, 6, null]);
      const encoded = runLengthEncoder.encode({
        dataType: DataType.INT32,
        length: column.length,
        values: column.data,
        stats: sourceOf(DataType.INT32, Array.from(column.data)).stats,
      });
      column.encoded = encoded;
      column._data = undefined;

      expect(column.get(0)).toBe(6);
      expect(column.get(1)).toBeNull();
      expect(column.get(2)).toBe(6);
      expect(column.get(4)).toBeNull();
    });

    it('encodes an all-null column as a single run of the untouched slots', () => {
      const values = new Array(16).fill(0);
      const vector = encode(DataType.INT32, values);

      expect(vector.runCount).toBe(1);
      expect(Array.from(vector.decode())).toEqual(Array.from(integerArrayOf(DataType.INT32, values)));
    });
  });
});
