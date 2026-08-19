import { describe, it, expect } from 'vitest';
import { ReservoirSample, deterministicRandom } from '../../src/catalog/reservoir-sample.js';

function sampleOf(capacity, count, seed = 1) {
  const reservoir = new ReservoirSample(capacity, deterministicRandom(seed));
  for (let i = 0; i < count; i++) reservoir.offer(i);
  return reservoir;
}

describe('ReservoirSample', () => {
  it('keeps every item while under capacity', () => {
    expect(sampleOf(10, 4).items).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds its capacity', () => {
    expect(sampleOf(100, 100000).items).toHaveLength(100);
  });

  it('samples beyond the head of the stream', () => {
    const items = sampleOf(100, 100000).items;
    const fromTail = items.filter(value => value >= 50000);
    expect(fromTail.length).toBeGreaterThan(0);
  });

  it('spreads the sample across the whole stream rather than one region', () => {
    const items = sampleOf(200, 100000).items;
    const quartiles = [0, 0, 0, 0];
    for (const value of items) quartiles[Math.min(3, Math.floor(value / 25000))]++;
    for (const count of quartiles) expect(count).toBeGreaterThan(20);
  });

  it('is reproducible for the same seed', () => {
    expect(sampleOf(50, 10000, 7).items).toEqual(sampleOf(50, 10000, 7).items);
  });

  it('differs across seeds', () => {
    expect(sampleOf(50, 10000, 7).items).not.toEqual(sampleOf(50, 10000, 8).items);
  });

  it('counts everything it was offered', () => {
    expect(sampleOf(10, 5000).seenCount).toBe(5000);
  });

  it('drops everything when capacity is zero', () => {
    expect(sampleOf(0, 100).items).toEqual([]);
  });
});
