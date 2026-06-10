import { describe, it, expect } from 'vitest';
import { MorselScheduler } from '../../src/parallel/morsel-scheduler.js';

describe('MorselScheduler', () => {
  it('dispenses the whole range exactly once in fixed-size morsels', () => {
    const scheduler = new MorselScheduler(10, 3);
    const morsels = Array.from(scheduler.drain());
    expect(morsels).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
      { start: 6, end: 9 },
      { start: 9, end: 10 },
    ]);
    expect(scheduler.next()).toBeNull();
  });

  it('attached consumers share one atomic counter without overlap', () => {
    const scheduler = new MorselScheduler(100, 7);
    const a = MorselScheduler.attach(scheduler.descriptor());
    const b = MorselScheduler.attach(scheduler.descriptor());

    const seen = [];
    let morsel;
    let turn = 0;
    while ((morsel = (turn++ % 2 === 0 ? a : b).next()) !== null) {
      seen.push(morsel);
    }

    seen.sort((x, y) => x.start - y.start);
    let cursor = 0;
    for (const { start, end } of seen) {
      expect(start).toBe(cursor);
      expect(end).toBeGreaterThan(start);
      cursor = end;
    }
    expect(cursor).toBe(100);
  });

  it('returns null immediately for an empty range and clamps morsel size to 1', () => {
    expect(new MorselScheduler(0, 5).next()).toBeNull();
    const tiny = new MorselScheduler(2, 0);
    expect(tiny.next()).toEqual({ start: 0, end: 1 });
    expect(tiny.next()).toEqual({ start: 1, end: 2 });
    expect(tiny.next()).toBeNull();
  });
});
