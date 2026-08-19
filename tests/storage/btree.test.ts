import { describe, it, expect } from 'vitest';
import { BTreeIndex } from '../../src/storage/btree.js';
import { DataType } from '../../src/storage/data-type.js';

describe('BTreeIndex', () => {
  describe('insert and search', () => {
    it('finds all inserted keys', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.insert(10, { pageId: 'p0', rowIndex: 0 });
      tree.insert(20, { pageId: 'p0', rowIndex: 1 });
      tree.insert(30, { pageId: 'p0', rowIndex: 2 });
      expect(tree.search(10)).toEqual([{ pageId: 'p0', rowIndex: 0 }]);
      expect(tree.search(20)).toEqual([{ pageId: 'p0', rowIndex: 1 }]);
      expect(tree.search(30)).toEqual([{ pageId: 'p0', rowIndex: 2 }]);
    });

    it('returns empty for missing keys', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.insert(5, { pageId: 'p0', rowIndex: 0 });
      expect(tree.search(99)).toEqual([]);
      expect(tree.search(-1)).toEqual([]);
    });

    it('accumulates multiple locations for duplicate keys', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.insert(10, { pageId: 'p0', rowIndex: 0 });
      tree.insert(10, { pageId: 'p0', rowIndex: 5 });
      tree.insert(10, { pageId: 'p1', rowIndex: 3 });
      const results = tree.search(10);
      expect(results).toHaveLength(3);
      expect(results).toContainEqual({ pageId: 'p0', rowIndex: 0 });
      expect(results).toContainEqual({ pageId: 'p0', rowIndex: 5 });
      expect(results).toContainEqual({ pageId: 'p1', rowIndex: 3 });
    });
  });

  describe('splitting under small order', () => {
    it('all keys searchable after 100 sequential inserts', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.order = 4;
      for (let i = 0; i < 100; i++) {
        tree.insert(i, { pageId: 'p0', rowIndex: i });
      }
      for (let i = 0; i < 100; i++) {
        expect(tree.search(i)).toEqual([{ pageId: 'p0', rowIndex: i }]);
      }
    });

    it('all keys searchable after 100 reverse inserts', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.order = 4;
      for (let i = 99; i >= 0; i--) {
        tree.insert(i, { pageId: 'p0', rowIndex: i });
      }
      for (let i = 0; i < 100; i++) {
        expect(tree.search(i)).toEqual([{ pageId: 'p0', rowIndex: i }]);
      }
    });

    it('handles random-order inserts with splits', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.order = 4;
      const keys = [50, 20, 80, 10, 30, 70, 90, 5, 15, 25, 35, 60, 75, 85, 95];
      for (const k of keys) {
        tree.insert(k, { pageId: 'p0', rowIndex: k });
      }
      for (const k of keys) {
        expect(tree.search(k)).toEqual([{ pageId: 'p0', rowIndex: k }]);
      }
    });

    it('root splits when tree grows beyond single node', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.order = 4;
      for (let i = 0; i < 10; i++) {
        tree.insert(i, { pageId: 'p', rowIndex: i });
      }
      expect(tree.root.isLeaf).toBe(false);
    });
  });

  describe('range queries', () => {
    function buildTree(values) {
      const tree = new BTreeIndex(DataType.INT32);
      tree.order = 4;
      for (const v of values) {
        tree.insert(v, { pageId: 'p0', rowIndex: v });
      }
      return tree;
    }

    function rangeRows(tree, low, high, lowInc, highInc) {
      return [...tree.range(low, high, lowInc, highInc)].map(r => r.rowIndex);
    }

    it('[3, 7] inclusive', () => {
      const tree = buildTree([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(rangeRows(tree, 3, 7, true, true)).toEqual([3, 4, 5, 6, 7]);
    });

    it('(2, 4] exclusive low', () => {
      const tree = buildTree([1, 2, 3, 4, 5]);
      expect(rangeRows(tree, 2, 4, false, true)).toEqual([3, 4]);
    });

    it('[2, 4) exclusive high', () => {
      const tree = buildTree([1, 2, 3, 4, 5]);
      expect(rangeRows(tree, 2, 4, true, false)).toEqual([2, 3]);
    });

    it('(1, 5) both exclusive', () => {
      const tree = buildTree([1, 2, 3, 4, 5]);
      expect(rangeRows(tree, 1, 5, false, false)).toEqual([2, 3, 4]);
    });

    it('open low bound scans from start', () => {
      const tree = buildTree([1, 2, 3, 4, 5]);
      expect(rangeRows(tree, null, 3, true, true)).toEqual([1, 2, 3]);
    });

    it('open high bound scans to end', () => {
      const tree = buildTree([1, 2, 3, 4, 5]);
      expect(rangeRows(tree, 3, null, true, true)).toEqual([3, 4, 5]);
    });

    it('fully open range yields all in order', () => {
      const tree = buildTree([5, 1, 3, 2, 4]);
      expect(rangeRows(tree, null, null, true, true)).toEqual([1, 2, 3, 4, 5]);
    });

    it('range with no matching keys returns empty', () => {
      const tree = buildTree([1, 2, 3, 4, 5]);
      expect(rangeRows(tree, 10, 20, true, true)).toEqual([]);
    });

    it('single-point range returns one result', () => {
      const tree = buildTree([1, 2, 3, 4, 5]);
      expect(rangeRows(tree, 3, 3, true, true)).toEqual([3]);
    });

    it('single-point exclusive range returns empty', () => {
      const tree = buildTree([1, 2, 3, 4, 5]);
      expect(rangeRows(tree, 3, 3, false, true)).toEqual([]);
      expect(rangeRows(tree, 3, 3, true, false)).toEqual([]);
    });

    it('range yields all locations for duplicate keys', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.order = 4;
      tree.insert(5, { pageId: 'a', rowIndex: 0 });
      tree.insert(5, { pageId: 'a', rowIndex: 1 });
      tree.insert(5, { pageId: 'a', rowIndex: 2 });
      tree.insert(10, { pageId: 'a', rowIndex: 3 });
      const results = [...tree.range(5, 5, true, true)];
      expect(results).toHaveLength(3);
    });
  });

  describe('leaf linked list', () => {
    it('full scan via range traverses all leaves in order', () => {
      const tree = new BTreeIndex(DataType.INT32);
      tree.order = 4;
      for (let i = 0; i < 50; i++) {
        tree.insert(i, { pageId: 'p', rowIndex: i });
      }
      const all = [...tree.range(null, null, true, true)].map(r => r.rowIndex);
      expect(all).toEqual(Array.from({ length: 50 }, (_, i) => i));
    });
  });

  describe('string keys', () => {
    it('inserts and searches string keys', () => {
      const tree = new BTreeIndex(DataType.VARCHAR);
      tree.insert('banana', { pageId: 'p0', rowIndex: 0 });
      tree.insert('apple', { pageId: 'p0', rowIndex: 1 });
      tree.insert('cherry', { pageId: 'p0', rowIndex: 2 });
      expect(tree.search('apple')).toEqual([{ pageId: 'p0', rowIndex: 1 }]);
      expect(tree.search('banana')).toEqual([{ pageId: 'p0', rowIndex: 0 }]);
      expect(tree.search('grape')).toEqual([]);
    });

    it('range query on strings follows lexicographic order', () => {
      const tree = new BTreeIndex(DataType.VARCHAR);
      tree.order = 4;
      const words = ['delta', 'alpha', 'charlie', 'bravo', 'echo'];
      for (const w of words) tree.insert(w, { pageId: 'p', rowIndex: 0 });
      const results = [...tree.range('bravo', 'delta', true, true)];
      const keys = [];
      let node = tree.root;
      while (!node.isLeaf) node = node.children[0];
      while (node) {
        for (let i = 0; i < node.keys.length; i++) {
          if (node.keys[i] >= 'bravo' && node.keys[i] <= 'delta') {
            keys.push(node.keys[i]);
          }
        }
        node = node.next;
      }
      expect(keys).toEqual(['bravo', 'charlie', 'delta']);
    });
  });

  describe('bigint keys', () => {
    it('handles INT64 bigint insert and search', () => {
      const tree = new BTreeIndex(DataType.INT64);
      tree.order = 4;
      tree.insert(100n, { pageId: 'p0', rowIndex: 0 });
      tree.insert(200n, { pageId: 'p0', rowIndex: 1 });
      tree.insert(50n, { pageId: 'p0', rowIndex: 2 });
      expect(tree.search(100n)).toEqual([{ pageId: 'p0', rowIndex: 0 }]);
      expect(tree.search(50n)).toEqual([{ pageId: 'p0', rowIndex: 2 }]);
      expect(tree.search(999n)).toEqual([]);
    });
  });
});
