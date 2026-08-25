import { describe, expect, it } from 'vitest';
import { clip, formatCount, formatPercent, percentChange } from '../../src/ui/format.js';

describe('formatCount', () => {
  it('abbreviates by magnitude', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1_500)).toBe('1.5K');
    expect(formatCount(6_001_215)).toBe('6.0M');
    expect(formatCount(504_030_118_016)).toBe('504B');
  });

  it('renders a missing number as a dash', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(Number.NaN)).toBe('—');
  });
});

describe('percentChange', () => {
  it('measures an ordinary move', () => {
    expect(percentChange(200, 100)).toBe(-50);
    expect(percentChange(100, 118)).toBeCloseTo(18);
  });

  it('reports a plan that was already free and stayed free as no change', () => {
    expect(percentChange(0, 0)).toBe(0);
  });

  it('refuses to put a percentage on a move away from zero', () => {
    expect(percentChange(0, 500)).toBeNull();
  });

  it('has no answer when either end is unknown', () => {
    expect(percentChange(null, 10)).toBeNull();
    expect(percentChange(10, null)).toBeNull();
  });
});

describe('formatPercent', () => {
  it('signs an increase and leaves a decrease with its minus', () => {
    expect(formatPercent(18)).toBe('+18%');
    expect(formatPercent(-34)).toBe('-34%');
  });

  it('keeps two decimals below one percent so a small move is not shown as nothing', () => {
    expect(formatPercent(-0.83)).toBe('-0.83%');
  });

  it('renders exactly zero without a sign', () => {
    expect(formatPercent(0)).toBe('0%');
  });
});

describe('clip', () => {
  it('leaves short text alone and ellipsises long text', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
  });
});
