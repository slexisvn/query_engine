import { describe, it, expect } from 'vitest';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';

describe('DictionaryColumn', () => {
  describe('dictionary deduplication', () => {
    it('maps same string to same dictionary index', () => {
      const col = new DictionaryColumn(8);
      col.set(0, 'apple');
      col.set(1, 'banana');
      col.set(2, 'apple');
      col.set(3, 'cherry');
      col.set(4, 'banana');
      expect(col.reverseDict.length).toBe(3);
      expect(col.indices[0]).toBe(col.indices[2]);
      expect(col.indices[1]).toBe(col.indices[4]);
      expect(col.get(0)).toBe('apple');
      expect(col.get(4)).toBe('banana');
    });

    it('treats different strings as different entries', () => {
      const col = new DictionaryColumn(8);
      col.set(0, 'abc');
      col.set(1, 'ABC');
      col.set(2, 'Abc');
      expect(col.reverseDict.length).toBe(3);
    });
  });

  describe('overwrite behavior', () => {
    it('overwriting index with different string updates the index mapping', () => {
      const col = new DictionaryColumn(8);
      col.set(0, 'old');
      expect(col.get(0)).toBe('old');
      col.set(0, 'new');
      expect(col.get(0)).toBe('new');
    });

    it('overwriting value with null and back', () => {
      const col = new DictionaryColumn(8);
      col.set(0, 'hello');
      col.set(0, null);
      expect(col.get(0)).toBeNull();
      col.set(0, 'world');
      expect(col.get(0)).toBe('world');
    });
  });

  describe('null handling', () => {
    it('tracks nulls correctly with interleaved non-null values', () => {
      const col = new DictionaryColumn(8);
      col.set(0, null);
      col.set(1, 'a');
      col.set(2, null);
      col.set(3, 'b');
      col.set(4, null);
      expect(col.isNull(0)).toBe(true);
      expect(col.isNull(1)).toBe(false);
      expect(col.isNull(2)).toBe(true);
      expect(col.get(1)).toBe('a');
      expect(col.get(3)).toBe('b');
    });

    it('handles nulls across bitmap word boundary', () => {
      const col = new DictionaryColumn(128);
      col.set(31, 'at_boundary');
      col.set(32, null);
      col.set(33, 'after_boundary');
      expect(col.get(31)).toBe('at_boundary');
      expect(col.isNull(32)).toBe(true);
      expect(col.get(33)).toBe('after_boundary');
    });
  });

  describe('grow with data preservation', () => {
    it('preserves all data and nulls through multiple grows', () => {
      const col = new DictionaryColumn(2);
      const expected = [];
      for (let i = 0; i < 20; i++) {
        const val = i % 4 === 0 ? null : `val_${i}`;
        col.append(val);
        expected.push(val);
      }
      expect(col.capacity).toBeGreaterThan(2);
      for (let i = 0; i < 20; i++) {
        expect(col.get(i)).toBe(expected[i]);
      }
    });
  });

  describe('appendBatch with dedup', () => {
    it('batch append deduplicates and maintains order', () => {
      const col = new DictionaryColumn(16);
      col.appendBatch(['red', 'green', 'blue', 'red', 'green', 'red']);
      expect(col.length).toBe(6);
      expect(col.reverseDict.length).toBe(3);
      expect(col.get(0)).toBe('red');
      expect(col.get(3)).toBe('red');
      expect(col.get(5)).toBe('red');
      expect(col.indices[0]).toBe(col.indices[3]);
      expect(col.indices[0]).toBe(col.indices[5]);
    });
  });

  describe('slice', () => {
    it('shares dictionary reference but has independent indices', () => {
      const col = new DictionaryColumn(8);
      col.appendBatch(['a', 'b', 'c', 'd', 'e']);
      const sliced = col.slice(2, 5);
      expect(sliced.get(0)).toBe('c');
      expect(sliced.get(1)).toBe('d');
      expect(sliced.get(2)).toBe('e');
      expect(sliced.dictionary).toBe(col.dictionary);
      expect(sliced.reverseDict).toBe(col.reverseDict);
      expect(sliced.length).toBe(3);
    });

    it('preserves nulls at slice boundaries', () => {
      const col = new DictionaryColumn(8);
      col.set(0, 'x');
      col.set(1, null);
      col.set(2, null);
      col.set(3, 'y');
      col.set(4, null);
      const sliced = col.slice(1, 4);
      expect(sliced.get(0)).toBeNull();
      expect(sliced.get(1)).toBeNull();
      expect(sliced.get(2)).toBe('y');
    });
  });
});
