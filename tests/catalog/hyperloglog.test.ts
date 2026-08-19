import { describe, it, expect } from 'vitest';
import { HyperLogLog } from '../../src/catalog/hyperloglog.js';
import { hashValue } from '../../src/utils/hash.js';

function countDistinct(precision, values) {
  const hll = new HyperLogLog(precision);
  for (const value of values) hll.addHash(hashValue(value));
  return hll.estimate();
}

describe('HyperLogLog', () => {
  it('reports zero for an empty stream', () => {
    expect(new HyperLogLog(12).estimate()).toBe(0);
  });

  it('counts a small distinct set exactly via linear counting', () => {
    expect(countDistinct(12, [1, 2, 3, 4, 5])).toBe(5);
  });

  it('ignores repeated values', () => {
    const repeated = Array.from({ length: 5000 }, (_, i) => i % 7);
    expect(countDistinct(12, repeated)).toBe(7);
  });

  it('estimates a large distinct set within two percent', () => {
    const distinct = Array.from({ length: 100000 }, (_, i) => i);
    const estimate = countDistinct(14, distinct);
    expect(Math.abs(estimate - 100000) / 100000).toBeLessThan(0.02);
  });

  it('separates high cardinality from low cardinality', () => {
    const low = countDistinct(12, Array.from({ length: 20000 }, (_, i) => i % 50));
    const high = countDistinct(12, Array.from({ length: 20000 }, (_, i) => i));
    expect(high).toBeGreaterThan(low * 100);
  });

  it('uses memory proportional to the register count, not the stream', () => {
    const hll = new HyperLogLog(12);
    for (let i = 0; i < 200000; i++) hll.addHash(hashValue(i));
    expect(hll.registers.length).toBe(4096);
  });

  it('counts string values distinctly from their numeric spelling', () => {
    expect(countDistinct(12, [1, '1', 2, '2'])).toBe(4);
  });
});
