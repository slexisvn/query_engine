import { describe, it, expect } from 'vitest';
import { Column } from '../../src/storage/column.js';
import { DataType, getDecimalScale, getDecimalScaleNumber, setDecimalScale, timestampToEpochMs, epochMsToTimestamp, epochDaysToEpochMs, epochMsToEpochDays, isTemporal } from '../../src/storage/data-type.js';

describe('Column', () => {
  describe('null bitmap', () => {
    it('tracks nulls across word boundaries (index > 32)', () => {
      const col = new Column(DataType.INT32, 128);
      col.set(0, 10);
      col.set(33, null);
      col.set(63, null);
      col.set(64, 99);
      col.set(65, null);
      expect(col.isNull(0)).toBe(false);
      expect(col.isNull(33)).toBe(true);
      expect(col.isNull(63)).toBe(true);
      expect(col.get(64)).toBe(99);
      expect(col.isNull(65)).toBe(true);
    });

    it('overwriting null with value clears null bit', () => {
      const col = new Column(DataType.INT32, 8);
      col.set(0, null);
      expect(col.get(0)).toBeNull();
      col.set(0, 42);
      expect(col.get(0)).toBe(42);
      expect(col.isNull(0)).toBe(false);
    });

    it('overwriting value with null sets null bit', () => {
      const col = new Column(DataType.INT32, 8);
      col.set(0, 42);
      expect(col.get(0)).toBe(42);
      col.set(0, null);
      expect(col.get(0)).toBeNull();
      expect(col.isNull(0)).toBe(true);
    });

    it('non-null column returns hasNulls false', () => {
      const col = new Column(DataType.INT32, 8);
      col.set(0, 1);
      col.set(1, 2);
      expect(col.hasNulls).toBe(false);
      expect(col.isNull(0)).toBe(false);
    });
  });

  describe('BOOLEAN conversion', () => {
    it('stores as 0/1 internally but returns true/false', () => {
      const col = new Column(DataType.BOOLEAN, 4);
      col.set(0, true);
      col.set(1, false);
      expect(col.data[0]).toBe(1);
      expect(col.data[1]).toBe(0);
      expect(col.get(0)).toBe(true);
      expect(col.get(1)).toBe(false);
    });
  });

  describe('VARCHAR string buffer growth', () => {
    it('grows string buffer multiple times for large data', () => {
      const col = new Column(DataType.VARCHAR, 16);
      const strings = [];
      for (let i = 0; i < 10; i++) {
        const s = `str_${'x'.repeat(500)}_${i}`;
        strings.push(s);
        col.set(i, s);
      }
      for (let i = 0; i < 10; i++) {
        expect(col.get(i)).toBe(strings[i]);
      }
      expect(col.stringBytes.length).toBeGreaterThan(4096);
    });

    it('handles sequential sets with interleaved reads', () => {
      const col = new Column(DataType.VARCHAR, 8);
      col.set(0, 'first');
      col.set(1, 'second');
      expect(col.get(0)).toBe('first');
      col.set(2, 'third');
      expect(col.get(1)).toBe('second');
      expect(col.get(2)).toBe('third');
    });
  });

  describe('append with capacity growth', () => {
    it('preserves all data through multiple grow cycles', () => {
      const col = new Column(DataType.INT32, 2);
      const expected = [];
      for (let i = 0; i < 20; i++) {
        col.append(i * 10);
        expected.push(i * 10);
      }
      expect(col.capacity).toBeGreaterThanOrEqual(20);
      for (let i = 0; i < 20; i++) {
        expect(col.get(i)).toBe(expected[i]);
      }
    });

    it('preserves nulls through grow', () => {
      const col = new Column(DataType.INT32, 2);
      col.append(1);
      col.append(null);
      col.append(3);
      col.append(null);
      col.append(5);
      expect(col.get(0)).toBe(1);
      expect(col.get(1)).toBeNull();
      expect(col.get(2)).toBe(3);
      expect(col.get(3)).toBeNull();
      expect(col.get(4)).toBe(5);
    });

    it('VARCHAR append grows both offsets and capacity', () => {
      const col = new Column(DataType.VARCHAR, 2);
      col.append('aaa');
      col.append('bbb');
      col.append('ccc');
      col.append('ddd');
      expect(col.get(0)).toBe('aaa');
      expect(col.get(1)).toBe('bbb');
      expect(col.get(2)).toBe('ccc');
      expect(col.get(3)).toBe('ddd');
      expect(col.capacity).toBeGreaterThan(2);
    });
  });

  describe('appendBatch', () => {
    it('appends mixed values and nulls', () => {
      const col = new Column(DataType.INT32, 8);
      col.appendBatch([10, null, 30, null, 50]);
      expect(col.length).toBe(5);
      expect(col.get(0)).toBe(10);
      expect(col.get(1)).toBeNull();
      expect(col.get(2)).toBe(30);
      expect(col.get(3)).toBeNull();
      expect(col.get(4)).toBe(50);
    });
  });

  describe('slice', () => {
    it('sliced INT32 column is independent from original', () => {
      const col = new Column(DataType.INT32, 8);
      col.appendBatch([10, 20, 30, 40, 50]);
      const sliced = col.slice(1, 4);
      expect(sliced.get(0)).toBe(20);
      expect(sliced.get(1)).toBe(30);
      expect(sliced.get(2)).toBe(40);
      expect(sliced.length).toBe(3);
    });

    it('sliced VARCHAR column copies string data correctly', () => {
      const col = new Column(DataType.VARCHAR, 8);
      col.set(0, 'alpha');
      col.set(1, 'beta');
      col.set(2, 'gamma');
      col.set(3, 'delta');
      const sliced = col.slice(1, 3);
      expect(sliced.get(0)).toBe('beta');
      expect(sliced.get(1)).toBe('gamma');
      expect(sliced.length).toBe(2);
    });

    it('preserves null pattern across word boundary in slice', () => {
      const col = new Column(DataType.INT32, 128);
      for (let i = 0; i < 64; i++) {
        col.set(i, i % 3 === 0 ? null : i);
      }
      const sliced = col.slice(30, 40);
      for (let i = 0; i < 10; i++) {
        const origIdx = 30 + i;
        if (origIdx % 3 === 0) {
          expect(sliced.get(i)).toBeNull();
        } else {
          expect(sliced.get(i)).toBe(origIdx);
        }
      }
    });
  });

  describe('INT64 bigint values', () => {
    it('stores and retrieves bigint correctly', () => {
      const col = new Column(DataType.INT64, 4);
      col.set(0, 9007199254740993n);
      col.set(1, -9007199254740993n);
      col.set(2, 0n);
      expect(col.get(0)).toBe(9007199254740993n);
      expect(col.get(1)).toBe(-9007199254740993n);
      expect(col.get(2)).toBe(0n);
    });
  });
});

describe('configurable decimal scale', () => {
  afterEach(() => {
    setDecimalScale(2);
  });

  it('default scale is 100 (2 digits)', () => {
    expect(getDecimalScale()).toBe(100n);
    expect(getDecimalScaleNumber()).toBe(100);
  });

  it('setDecimalScale(4) sets scale to 10000', () => {
    setDecimalScale(4);
    expect(getDecimalScale()).toBe(10000n);
    expect(getDecimalScaleNumber()).toBe(10000);
  });

  it('setDecimalScale(0) sets scale to 1', () => {
    setDecimalScale(0);
    expect(getDecimalScale()).toBe(1n);
    expect(getDecimalScaleNumber()).toBe(1);
  });

  it('setDecimalScale(6) sets scale to 1000000', () => {
    setDecimalScale(6);
    expect(getDecimalScale()).toBe(1000000n);
    expect(getDecimalScaleNumber()).toBe(1000000);
  });
});

describe('TIMESTAMP data-type utilities', () => {
  it('converts timestamp components to epoch ms', () => {
    const ms = timestampToEpochMs(2024, 6, 15, 10, 30, 45, 123);
    const ts = epochMsToTimestamp(ms);
    expect(ts.year).toBe(2024);
    expect(ts.month).toBe(6);
    expect(ts.day).toBe(15);
    expect(ts.hour).toBe(10);
    expect(ts.minute).toBe(30);
    expect(ts.second).toBe(45);
    expect(ts.ms).toBe(123);
  });

  it('converts between epoch days and epoch ms', () => {
    const days = 19888;
    const ms = epochDaysToEpochMs(days);
    expect(epochMsToEpochDays(ms)).toBe(days);
  });

  it('isTemporal returns true for DATE and TIMESTAMP', () => {
    expect(isTemporal(DataType.DATE)).toBe(true);
    expect(isTemporal(DataType.TIMESTAMP)).toBe(true);
    expect(isTemporal(DataType.INT32)).toBe(false);
    expect(isTemporal(DataType.VARCHAR)).toBe(false);
  });
});
