import { describe, expect, it } from 'vitest';
import { clip, formatCount, formatMs, formatPercent, formatSelectivity, formatValue, percentChange } from '../../src/ui/format.js';

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

  it('drops the sign entirely when the direction is already spelled out', () => {
    expect(formatPercent(140, false)).toBe('140%');
    expect(formatPercent(-34, false)).toBe('34%');
    expect(formatPercent(-0.83, false)).toBe('0.83%');
  });
});

describe('clip', () => {
  it('leaves short text alone and ellipsises long text', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('formatMs', () => {
  it('drops precision the timer cannot justify', () => {
    expect(formatMs(0.4)).toBe('<1 ms');
    expect(formatMs(0)).toBe('<1 ms');
  });

  it('keeps one decimal until the number is big enough to round', () => {
    expect(formatMs(1.24)).toBe('1.2 ms');
    expect(formatMs(99.9)).toBe('99.9 ms');
    expect(formatMs(140.6)).toBe('141 ms');
  });

  it('renders a missing duration as a dash', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(Number.NaN)).toBe('—');
  });
});

describe('formatSelectivity', () => {
  it('reads as a percentage like every other ratio in the UI', () => {
    expect(formatSelectivity(0.2)).toBe('20%');
    expect(formatSelectivity(1)).toBe('100%');
  });

  it('keeps a decimal for shares that would round away', () => {
    expect(formatSelectivity(0.034)).toBe('3.4%');
    expect(formatSelectivity(0.002)).toBe('0.2%');
  });

  it('falls back to exponent notation for a needle in a haystack', () => {
    expect(formatSelectivity(0.0000004)).toBe('4.0e-5%');
  });

  it('distinguishes an empty result from an unknown one', () => {
    expect(formatSelectivity(0)).toBe('0%');
    expect(formatSelectivity(null)).toBe('—');
  });
});

describe('formatValue', () => {
  it('spells a DATE out instead of abbreviating its epoch day', () => {
    expect(formatValue(8035, 'DATE')).toBe('1992-01-01');
    expect(formatValue(10440, 'DATE')).toBe('1998-08-02');
  });

  it('still abbreviates the same number when the column is not a date', () => {
    expect(formatValue(8035)).toBe('8.0K');
    expect(formatValue(8035, 'INT32')).toBe('8.0K');
  });

  it('renders the value kinds statistics actually hold', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue(123n)).toBe('123');
  });

  it('clips a string too long for the cell', () => {
    expect(formatValue('Customer#000000001')).toBe('Customer#000000001');
    expect(formatValue('Customer#0000000012')).toBe('Customer#00000000…');
  });
});
