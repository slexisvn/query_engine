import { describe, it, expect } from 'vitest';
import { bitPackedEncoder } from '../../../src/storage/encoding/bit-packed.js';
import { DataType } from '../../../src/storage/data-type.js';
import { Config } from '../../../src/config.js';
import { INT32_MAX, readBack, roundTripVector, sourceOf } from '../../helpers/encoding-fixtures.js';

function encode(dataType, values) {
  return bitPackedEncoder.encode(sourceOf(dataType, values));
}

function widthSample(bits) {
  const max = bits >= 32 ? 4294967295 : (2 ** bits) - 1;
  return [0, 1, Math.floor(max / 3), Math.floor(max / 2), max, 0, max, 1];
}

describe('bit-packed encoding', () => {
  describe('value round-trip', () => {
    it('reads back values at every bit width from 1 to 32', () => {
      for (let bits = 1; bits <= 32; bits++) {
        const values = widthSample(bits).map(BigInt);
        const vector = encode(DataType.INT64, values);

        expect(vector.bitWidth).toBe(bits);
        expect(readBack(vector)).toEqual(values);
        expect(Array.from(vector.decode())).toEqual(values);
      }
    });

    it('reads back values that straddle 32-bit word boundaries', () => {
      const values = Array.from({ length: 200 }, (_, i) => (i * 37) % 8192);
      const vector = encode(DataType.INT32, values);

      expect(vector.bitWidth).toBe(13);
      expect(readBack(vector)).toEqual(values);
    });

    it('handles a single-value column', () => {
      const vector = encode(DataType.INT32, [5]);

      expect(readBack(vector)).toEqual([5]);
      expect(Array.from(vector.decode())).toEqual([5]);
    });

    it('packs an all-zero column at the minimum width', () => {
      const vector = encode(DataType.INT32, new Array(40).fill(0));

      expect(vector.bitWidth).toBe(1);
      expect(readBack(vector)).toEqual(new Array(40).fill(0));
    });

    it('keeps the largest INT32 value exact', () => {
      const vector = encode(DataType.INT32, [0, INT32_MAX, 1, INT32_MAX]);

      expect(vector.bitWidth).toBe(31);
      expect(readBack(vector)).toEqual([0, INT32_MAX, 1, INT32_MAX]);
    });

    it('keeps a full 32-bit INT64 value exact', () => {
      const values = [0n, 4294967295n, 2147483648n, 4294967295n];
      const vector = encode(DataType.INT64, values);

      expect(vector.bitWidth).toBe(32);
      expect(readBack(vector)).toEqual(values);
      expect(Array.from(vector.decode())).toEqual(values);
    });
  });

  describe('serialization', () => {
    it('writes exactly the bytes it reports and restores the same values', () => {
      const values = Array.from({ length: 129 }, (_, i) => i % 97);
      const vector = encode(DataType.INT32, values);
      const { restored, written, consumed } = roundTripVector(bitPackedEncoder, vector);

      expect(written).toBe(vector.byteSize());
      expect(consumed).toBe(vector.byteSize());
      expect(readBack(restored)).toEqual(values);
    });

    it('restores INT64 values as bigints', () => {
      const values = [0n, 7n, 255n, 3n];
      const { restored } = roundTripVector(bitPackedEncoder, encode(DataType.INT64, values));

      expect(readBack(restored)).toEqual(values);
    });
  });

  describe('planning', () => {
    it('refuses a column that contains a negative value', () => {
      const source = sourceOf(DataType.INT32, [1, -1, 4]);
      expect(bitPackedEncoder.plan(source.stats, DataType.INT32)).toBeNull();
    });

    it('refuses a column whose values need more than one word each', () => {
      const source = sourceOf(DataType.INT64, [0n, 2n ** 40n]);
      expect(bitPackedEncoder.plan(source.stats, DataType.INT64)).toBeNull();
    });

    it('accepts a narrow column and refuses a wide one at the configured ratio', () => {
      const saved = Config.encodingBitPackMaxWidthRatio;
      Config.encodingBitPackMaxWidthRatio = 0.5;
      try {
        const narrow = sourceOf(DataType.INT32, [0, 255]);
        const wide = sourceOf(DataType.INT32, [0, 1 << 20]);

        expect(bitPackedEncoder.plan(narrow.stats, DataType.INT32).withinThreshold).toBe(true);
        expect(bitPackedEncoder.plan(wide.stats, DataType.INT32).withinThreshold).toBe(false);
      } finally {
        Config.encodingBitPackMaxWidthRatio = saved;
      }
    });

    it('estimates the byte size the encoded vector actually occupies', () => {
      const source = sourceOf(DataType.INT32, Array.from({ length: 77 }, (_, i) => i % 33));
      const plan = bitPackedEncoder.plan(source.stats, DataType.INT32);

      expect(plan.bytes).toBe(bitPackedEncoder.encode(source).byteSize());
    });
  });
});
