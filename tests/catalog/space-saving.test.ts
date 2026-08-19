import { describe, it, expect } from 'vitest';
import { SpaceSavingCounter } from '../../src/catalog/space-saving.js';

describe('SpaceSavingCounter', () => {
  it('returns nothing before any observation', () => {
    expect(new SpaceSavingCounter(4).top(3)).toEqual([]);
  });

  it('ranks exact counts when everything fits in capacity', () => {
    const counter = new SpaceSavingCounter(8);
    for (const value of ['a', 'a', 'a', 'b', 'b', 'c']) counter.add(value);

    expect(counter.top(3)).toEqual([
      { value: 'a', count: 3 },
      { value: 'b', count: 2 },
      { value: 'c', count: 1 },
    ]);
  });

  it('never grows past its capacity under a high cardinality stream', () => {
    const counter = new SpaceSavingCounter(16);
    for (let i = 0; i < 50000; i++) counter.add(`v${i}`);
    expect(counter.top(1000)).toHaveLength(16);
  });

  it('keeps the heavy hitters when cold values flood the stream', () => {
    const counter = new SpaceSavingCounter(16);
    for (let i = 0; i < 20000; i++) {
      counter.add(`cold${i}`);
      if (i % 3 === 0) counter.add('hot');
      if (i % 7 === 0) counter.add('warm');
    }

    const top = counter.top(2).map(item => item.value);
    expect(top).toContain('hot');
    expect(top).toContain('warm');
    expect(top[0]).toBe('hot');
  });

  it('does not undercount a heavy hitter it retained throughout', () => {
    const counter = new SpaceSavingCounter(8);
    for (let i = 0; i < 1000; i++) {
      counter.add('hot');
      counter.add(`cold${i}`);
    }
    const hot = counter.top(8).find(item => item.value === 'hot');
    expect(hot.count).toBeGreaterThanOrEqual(1000);
  });

  it('tracks how many observations it has seen', () => {
    const counter = new SpaceSavingCounter(2);
    for (const value of ['a', 'b', 'c', 'd']) counter.add(value);
    expect(counter.totalObserved).toBe(4);
  });
});
