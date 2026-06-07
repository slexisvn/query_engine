import { describe, it, expect } from 'vitest';
import { ChunkSerializer } from '../../src/storage/serializer.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataType } from '../../src/storage/data-type.js';

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values, dict }) => {
    if (dict) {
      const col = new DictionaryColumn(values.length || 1);
      for (let i = 0; i < values.length; i++) col.set(i, values[i]);
      col.length = values.length;
      return col;
    }
    const col = new Column(type, values.length || 1);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function roundTrip(chunk) {
  return ChunkSerializer.deserialize(ChunkSerializer.serialize(chunk));
}

describe('ChunkSerializer', () => {
  describe('fixed-width type round-trips', () => {
    it('INT32 preserves positive, negative, and zero', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.INT32, values: [1, -100, 0, 2147483647, -2147483648] },
      ]));
      expect(restored.size).toBe(5);
      expect(restored.columns[0].get(0)).toBe(1);
      expect(restored.columns[0].get(1)).toBe(-100);
      expect(restored.columns[0].get(2)).toBe(0);
      expect(restored.columns[0].get(3)).toBe(2147483647);
      expect(restored.columns[0].get(4)).toBe(-2147483648);
    });

    it('FLOAT64 preserves precision', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.FLOAT64, values: [3.141592653589793, -2.718281828, 0.0, 1e308] },
      ]));
      expect(restored.columns[0].get(0)).toBeCloseTo(3.141592653589793, 14);
      expect(restored.columns[0].get(1)).toBeCloseTo(-2.718281828);
      expect(restored.columns[0].get(2)).toBe(0);
    });

    it('BOOLEAN preserves true/false semantics', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.BOOLEAN, values: [true, false, true, false] },
      ]));
      expect(restored.columns[0].get(0)).toBe(true);
      expect(restored.columns[0].get(1)).toBe(false);
      expect(restored.columns[0].get(2)).toBe(true);
      expect(restored.columns[0].get(3)).toBe(false);
    });

    it('INT64 preserves bigint values beyond Number.MAX_SAFE_INTEGER', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.INT64, values: [9007199254740993n, -9007199254740993n, 0n] },
      ]));
      expect(restored.columns[0].get(0)).toBe(9007199254740993n);
      expect(restored.columns[0].get(1)).toBe(-9007199254740993n);
      expect(restored.columns[0].get(2)).toBe(0n);
    });

    it('DATE preserves epoch day values', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.DATE, values: [0, 19000, -365] },
      ]));
      expect(restored.columns[0].get(0)).toBe(0);
      expect(restored.columns[0].get(1)).toBe(19000);
      expect(restored.columns[0].get(2)).toBe(-365);
    });
  });

  describe('VARCHAR round-trips', () => {
    it('flat Column preserves strings including empty', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.VARCHAR, values: ['hello', '', 'world'] },
      ]));
      expect(restored.columns[0]).toBeInstanceOf(Column);
      expect(restored.columns[0].get(0)).toBe('hello');
      expect(restored.columns[0].get(1)).toBe('');
      expect(restored.columns[0].get(2)).toBe('world');
    });

    it('DictionaryColumn preserves strings and dedup structure', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.VARCHAR, values: ['apple', 'banana', 'apple', 'cherry'], dict: true },
      ]));
      expect(restored.columns[0]).toBeInstanceOf(DictionaryColumn);
      expect(restored.columns[0].get(0)).toBe('apple');
      expect(restored.columns[0].get(1)).toBe('banana');
      expect(restored.columns[0].get(2)).toBe('apple');
      expect(restored.columns[0].get(3)).toBe('cherry');
      expect(restored.columns[0].reverseDict.length).toBe(3);
      expect(restored.columns[0].dictionary.get('apple')).toBe(restored.columns[0].dictionary.get('apple'));
    });
  });

  describe('null handling', () => {
    it('preserves null pattern in INT32 column', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.INT32, values: [10, null, 30, null, 50] },
      ]));
      expect(restored.columns[0].get(0)).toBe(10);
      expect(restored.columns[0].get(1)).toBeNull();
      expect(restored.columns[0].get(2)).toBe(30);
      expect(restored.columns[0].get(3)).toBeNull();
      expect(restored.columns[0].get(4)).toBe(50);
      expect(restored.columns[0].hasNulls).toBe(true);
    });

    it('preserves null pattern in DictionaryColumn', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.VARCHAR, values: ['a', null, 'b', null], dict: true },
      ]));
      expect(restored.columns[0].get(0)).toBe('a');
      expect(restored.columns[0].get(1)).toBeNull();
      expect(restored.columns[0].get(2)).toBe('b');
      expect(restored.columns[0].get(3)).toBeNull();
    });

    it('no-null column has hasNulls false after round-trip', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.INT32, values: [1, 2, 3] },
      ]));
      expect(restored.columns[0].hasNulls).toBe(false);
    });
  });

  describe('multi-column chunks', () => {
    it('mixed types serialize independently and correctly', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.INT32, values: [1, 2, 3] },
        { type: DataType.FLOAT64, values: [1.1, 2.2, 3.3] },
        { type: DataType.VARCHAR, values: ['x', 'y', 'z'], dict: true },
        { type: DataType.BOOLEAN, values: [true, false, true] },
      ]));
      expect(restored.columnCount()).toBe(4);
      expect(restored.size).toBe(3);
      expect(restored.columns[0].get(1)).toBe(2);
      expect(restored.columns[1].get(1)).toBeCloseTo(2.2);
      expect(restored.columns[2].get(1)).toBe('y');
      expect(restored.columns[3].get(0)).toBe(true);
      expect(restored.columns[3].get(1)).toBe(false);
    });

    it('multi-column with nulls in different columns', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.INT32, values: [null, 2, 3] },
        { type: DataType.VARCHAR, values: ['a', null, 'c'], dict: true },
      ]));
      expect(restored.columns[0].get(0)).toBeNull();
      expect(restored.columns[0].get(1)).toBe(2);
      expect(restored.columns[1].get(0)).toBe('a');
      expect(restored.columns[1].get(1)).toBeNull();
      expect(restored.columns[1].get(2)).toBe('c');
    });
  });

  describe('edge cases', () => {
    it('empty chunk (0 rows) round-trips', () => {
      const cols = [new Column(DataType.INT32, 4)];
      const chunk = new DataChunk(cols, 0);
      const restored = roundTrip(chunk);
      expect(restored.size).toBe(0);
      expect(restored.columnCount()).toBe(1);
    });

    it('single-row chunk round-trips', () => {
      const restored = roundTrip(makeChunk([
        { type: DataType.INT32, values: [42] },
      ]));
      expect(restored.size).toBe(1);
      expect(restored.columns[0].get(0)).toBe(42);
    });

    it('serialize output is a Buffer', () => {
      const chunk = makeChunk([{ type: DataType.INT32, values: [1] }]);
      const buf = ChunkSerializer.serialize(chunk);
      expect(Buffer.isBuffer(buf)).toBe(true);
    });
  });
});
