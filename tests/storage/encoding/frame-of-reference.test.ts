import { describe, it, expect } from 'vitest';
import { frameOfReferenceEncoder } from '../../../src/storage/encoding/frame-of-reference.js';
import { DataType } from '../../../src/storage/data-type.js';
import { Config } from '../../../src/config.js';
import {
  INT32_MAX, INT32_MIN, INT64_MAX, INT64_MIN,
  readBack, roundTripVector, sourceOf,
} from '../../helpers/encoding-fixtures.js';

function encode(dataType, values) {
  return frameOfReferenceEncoder.encode(sourceOf(dataType, values));
}

describe('frame-of-reference encoding', () => {
  describe('value round-trip', () => {
    it('reads back a narrow INT32 band anchored far from zero', () => {
      const values = Array.from({ length: 50 }, (_, i) => 1000000 + (i % 7));
      const vector = encode(DataType.INT32, values);

      expect(vector.anchor).toBe(1000000n);
      expect(readBack(vector)).toEqual(values);
      expect(Array.from(vector.decode())).toEqual(values);
    });

    it('reads back a band anchored at a negative minimum', () => {
      const values = [-500, -499, -1, 0, 12, -500];
      const vector = encode(DataType.INT32, values);

      expect(vector.anchor).toBe(-500n);
      expect(readBack(vector)).toEqual(values);
    });

    it('reads back INT64 offsets without narrowing the anchor', () => {
      const anchor = 4000000000000n;
      const values = [anchor, anchor + 1n, anchor + 4294967295n, anchor + 7n];
      const vector = encode(DataType.INT64, values);

      expect(vector.anchor).toBe(anchor);
      expect(readBack(vector)).toEqual(values);
      expect(Array.from(vector.decode())).toEqual(values);
    });

    it('handles a single-value column', () => {
      const vector = encode(DataType.INT32, [-9]);

      expect(readBack(vector)).toEqual([-9]);
      expect(vector.offsets.length).toBe(1);
    });

    it('handles a constant column as a zero-width band', () => {
      const vector = encode(DataType.INT32, new Array(20).fill(42));

      expect(vector.offsets.BYTES_PER_ELEMENT).toBe(1);
      expect(readBack(vector)).toEqual(new Array(20).fill(42));
    });

    it('spans the whole INT32 range', () => {
      const values = [INT32_MIN, 0, INT32_MAX, -1];
      const vector = encode(DataType.INT32, values);

      expect(vector.offsets.BYTES_PER_ELEMENT).toBe(4);
      expect(readBack(vector)).toEqual(values);
    });
  });

  describe('offset container selection', () => {
    it('uses one byte per offset up to a range of 255', () => {
      const vector = encode(DataType.INT32, [10, 265]);
      expect(vector.offsets.BYTES_PER_ELEMENT).toBe(1);
    });

    it('steps up to two bytes per offset at a range of 256', () => {
      const vector = encode(DataType.INT32, [10, 266]);
      expect(vector.offsets.BYTES_PER_ELEMENT).toBe(2);
    });

    it('steps up to four bytes per offset at a range of 65536', () => {
      expect(encode(DataType.INT32, [0, 65535]).offsets.BYTES_PER_ELEMENT).toBe(2);
      expect(encode(DataType.INT32, [0, 65536]).offsets.BYTES_PER_ELEMENT).toBe(4);
    });

    it('accepts a range one below the four-byte limit and refuses one at it', () => {
      const inside = sourceOf(DataType.INT64, [0n, 4294967295n]);
      const outside = sourceOf(DataType.INT64, [0n, 4294967296n]);

      expect(frameOfReferenceEncoder.plan(inside.stats, DataType.INT64).bytes).toBeGreaterThan(0);
      expect(frameOfReferenceEncoder.plan(outside.stats, DataType.INT64)).toBeNull();
    });

    it('refuses the full INT64 range', () => {
      const source = sourceOf(DataType.INT64, [INT64_MIN, INT64_MAX]);
      expect(frameOfReferenceEncoder.plan(source.stats, DataType.INT64)).toBeNull();
    });
  });

  describe('serialization', () => {
    it('writes exactly the bytes it reports and restores the same values', () => {
      const values = Array.from({ length: 300 }, (_, i) => 70000 + (i % 900));
      const vector = encode(DataType.INT32, values);
      const { restored, written, consumed } = roundTripVector(frameOfReferenceEncoder, vector);

      expect(written).toBe(vector.byteSize());
      expect(consumed).toBe(vector.byteSize());
      expect(restored.offsets.BYTES_PER_ELEMENT).toBe(vector.offsets.BYTES_PER_ELEMENT);
      expect(readBack(restored)).toEqual(values);
    });

    it('restores a negative INT64 anchor', () => {
      const values = [-9000000000n, -8999999999n, -9000000000n];
      const { restored } = roundTripVector(frameOfReferenceEncoder, encode(DataType.INT64, values));

      expect(restored.anchor).toBe(-9000000000n);
      expect(readBack(restored)).toEqual(values);
    });
  });

  describe('planning', () => {
    it('accepts a narrow band and refuses a wide one at the configured ratio', () => {
      const saved = Config.encodingForMaxWidthRatio;
      Config.encodingForMaxWidthRatio = 0.5;
      try {
        const narrow = sourceOf(DataType.INT32, [0, 200]);
        const wide = sourceOf(DataType.INT32, [0, 70000]);

        expect(frameOfReferenceEncoder.plan(narrow.stats, DataType.INT32).withinThreshold).toBe(true);
        expect(frameOfReferenceEncoder.plan(wide.stats, DataType.INT32).withinThreshold).toBe(false);
      } finally {
        Config.encodingForMaxWidthRatio = saved;
      }
    });

    it('estimates the byte size the encoded vector actually occupies', () => {
      const source = sourceOf(DataType.INT32, Array.from({ length: 64 }, (_, i) => 500 + i));
      const plan = frameOfReferenceEncoder.plan(source.stats, DataType.INT32);

      expect(plan.bytes).toBe(frameOfReferenceEncoder.encode(source).byteSize());
    });
  });
});
