import { describe, it, expect } from 'vitest';
import {
  popcount,
  subsets,
  subsetsByAscendingSize,
  bitIndices,
  descendingBitIndices,
  lowestBitIndex,
  maskBelowOrEqual,
} from '../../../src/optimizer/join-order/bitmask.js';

describe('popcount', () => {
  it('counts bits in zero', () => {
    expect(popcount(0)).toBe(0);
  });

  it('counts bits in powers of two', () => {
    expect(popcount(1)).toBe(1);
    expect(popcount(2)).toBe(1);
    expect(popcount(4)).toBe(1);
    expect(popcount(8)).toBe(1);
  });

  it('counts bits in mixed values', () => {
    expect(popcount(0b111)).toBe(3);
    expect(popcount(0b1010)).toBe(2);
    expect(popcount(0b11111)).toBe(5);
    expect(popcount(0b10101010)).toBe(4);
  });
});

describe('subsets', () => {
  it('returns empty array for mask 0', () => {
    expect(subsets(0)).toEqual([]);
  });

  it('returns single element for single-bit mask', () => {
    expect(subsets(0b1)).toEqual([1]);
    expect(subsets(0b100)).toEqual([4]);
  });

  it('enumerates all non-empty subsets of 0b111', () => {
    const result = subsets(0b111);
    expect(result).toHaveLength(7);
    expect(new Set(result)).toEqual(new Set([0b001, 0b010, 0b011, 0b100, 0b101, 0b110, 0b111]));
  });

  it('only generates subsets within the mask', () => {
    const mask = 0b1010;
    const result = subsets(mask);
    for (const s of result) {
      expect(s & mask).toBe(s);
      expect(s).toBeGreaterThan(0);
    }
    expect(result).toHaveLength(3);
  });
});

describe('subsetsByAscendingSize', () => {
  it('returns nothing for an empty mask', () => {
    expect(subsetsByAscendingSize(0)).toEqual([]);
  });

  it('returns the same members as the unordered enumeration', () => {
    const ordered = subsetsByAscendingSize(0b1011);
    expect([...ordered].sort((a, b) => a - b)).toEqual([...subsets(0b1011)].sort((a, b) => a - b));
  });

  it('emits singletons before larger subsets', () => {
    const ordered = subsetsByAscendingSize(0b111);
    expect(ordered.slice(0, 3).every(mask => popcount(mask) === 1)).toBe(true);
  });

  it('emits the full mask last', () => {
    const ordered = subsetsByAscendingSize(0b1111);
    expect(ordered[ordered.length - 1]).toBe(0b1111);
  });

  it('never decreases in subset size', () => {
    const sizes = subsetsByAscendingSize(0b11111).map(popcount);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    }
  });

  it('differs from the unordered enumeration order for multi-bit masks', () => {
    expect(subsetsByAscendingSize(0b111)).not.toEqual(subsets(0b111));
  });
});

describe('bit helpers', () => {
  it('lists no indices for an empty mask', () => {
    expect([...bitIndices(0)]).toEqual([]);
  });

  it('lists set-bit indices in ascending order', () => {
    expect([...bitIndices(0b1010)]).toEqual([1, 3]);
  });

  it('lists set-bit indices in descending order', () => {
    expect(descendingBitIndices(0b1010)).toEqual([3, 1]);
  });

  it('finds the lowest set bit index', () => {
    expect(lowestBitIndex(0b1100)).toBe(2);
  });

  it('builds a mask covering every index up to and including the given one', () => {
    expect(maskBelowOrEqual(3)).toBe(0b1111);
  });

  it('builds a single-bit mask for index zero', () => {
    expect(maskBelowOrEqual(0)).toBe(0b1);
  });
});
