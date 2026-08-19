import { describe, it, expect } from 'vitest';
import { BloomFilter, bloomBitCount, bloomHashCount } from '../../src/utils/bloom-filter.js';

describe('bloom sizing', () => {
  it('grows the bit array with the expected entry count', () => {
    expect(bloomBitCount(10000, 0.01)).toBeGreaterThan(bloomBitCount(1000, 0.01));
  });

  it('grows the bit array as the target false positive rate tightens', () => {
    expect(bloomBitCount(1000, 0.001)).toBeGreaterThan(bloomBitCount(1000, 0.01));
  });

  it('never returns fewer bits than one word', () => {
    expect(bloomBitCount(0, 0.01)).toBeGreaterThanOrEqual(32);
  });

  it('derives at least one hash function', () => {
    expect(bloomHashCount(64, 0)).toBe(1);
  });

  it('derives more hash functions as bits per entry rise', () => {
    expect(bloomHashCount(100000, 1000)).toBeGreaterThan(bloomHashCount(10000, 1000));
  });
});

describe('BloomFilter membership', () => {
  it('reports nothing present when empty', () => {
    expect(new BloomFilter(1000, 0.01).mightContain(42)).toBe(false);
  });

  it('reports an inserted number as present', () => {
    const filter = new BloomFilter(1000, 0.01);
    filter.add(42);

    expect(filter.mightContain(42)).toBe(true);
  });

  it('reports an inserted string as present', () => {
    const filter = new BloomFilter(1000, 0.01);
    filter.add('alpha');

    expect(filter.mightContain('alpha')).toBe(true);
  });

  it('reports an inserted bigint as present', () => {
    const filter = new BloomFilter(1000, 0.01);
    filter.add(9007199254740993n);

    expect(filter.mightContain(9007199254740993n)).toBe(true);
  });

  it('reports an inserted boolean as present', () => {
    const filter = new BloomFilter(1000, 0.01);
    filter.add(true);

    expect(filter.mightContain(true)).toBe(true);
  });

  it('reports an inserted null as present', () => {
    const filter = new BloomFilter(1000, 0.01);
    filter.add(null);

    expect(filter.mightContain(null)).toBe(true);
  });

  it('never reports a false negative across many keys', () => {
    const filter = new BloomFilter(5000, 0.01);
    for (let i = 0; i < 5000; i++) filter.add(i);

    for (let i = 0; i < 5000; i++) expect(filter.mightContain(i)).toBe(true);
  });

  it('never reports a false negative for string keys', () => {
    const filter = new BloomFilter(2000, 0.01);
    for (let i = 0; i < 2000; i++) filter.add(`key-${i}`);

    for (let i = 0; i < 2000; i++) expect(filter.mightContain(`key-${i}`)).toBe(true);
  });

  it('rejects most absent keys', () => {
    const filter = new BloomFilter(5000, 0.01);
    for (let i = 0; i < 5000; i++) filter.add(i);

    let falsePositives = 0;
    for (let i = 100000; i < 110000; i++) {
      if (filter.mightContain(i)) falsePositives++;
    }

    expect(falsePositives / 10000).toBeLessThan(0.05);
  });

  it('stays near the requested false positive rate when loaded to capacity', () => {
    const filter = new BloomFilter(20000, 0.01);
    for (let i = 0; i < 20000; i++) filter.add(i);

    let falsePositives = 0;
    for (let i = 1000000; i < 1020000; i++) {
      if (filter.mightContain(i)) falsePositives++;
    }

    expect(falsePositives / 20000).toBeLessThan(0.03);
  });
});

describe('BloomFilter accounting', () => {
  it('counts inserted entries', () => {
    const filter = new BloomFilter(100, 0.01);
    filter.add(1);
    filter.add(2);

    expect(filter.insertedCount).toBe(2);
  });

  it('counts repeated inserts of the same key', () => {
    const filter = new BloomFilter(100, 0.01);
    filter.add(1);
    filter.add(1);

    expect(filter.insertedCount).toBe(2);
  });

  it('reports a byte size proportional to the bit count', () => {
    const small = new BloomFilter(100, 0.01);
    const large = new BloomFilter(100000, 0.01);

    expect(large.byteSize).toBeGreaterThan(small.byteSize);
  });

  it('reports zero saturation when empty', () => {
    expect(new BloomFilter(1000, 0.01).saturation).toBe(0);
  });

  it('reports rising saturation as keys are added', () => {
    const filter = new BloomFilter(1000, 0.01);
    for (let i = 0; i < 500; i++) filter.add(i);
    const half = filter.saturation;
    for (let i = 500; i < 1000; i++) filter.add(i);

    expect(filter.saturation).toBeGreaterThan(half);
  });
});
