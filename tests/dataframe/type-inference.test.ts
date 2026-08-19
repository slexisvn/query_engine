import { describe, it, expect } from 'vitest';
import { inferValueType, reconcileTypes, inferColumnType, coerceForColumn } from '../../src/dataframe/type-inference.js';
import { DataType } from '../../src/storage/data-type.js';

describe('inferValueType', () => {
  it('maps JS values to data types', () => {
    expect(inferValueType(true)).toBe(DataType.BOOLEAN);
    expect(inferValueType(42)).toBe(DataType.INT32);
    expect(inferValueType(3.14)).toBe(DataType.FLOAT64);
    expect(inferValueType(10n)).toBe(DataType.INT64);
    expect(inferValueType('x')).toBe(DataType.VARCHAR);
    expect(inferValueType(new Date(0))).toBe(DataType.TIMESTAMP);
    expect(inferValueType(null)).toBe(null);
    expect(inferValueType(undefined)).toBe(null);
  });
});

describe('reconcileTypes', () => {
  it('ignores nulls', () => {
    expect(reconcileTypes(null, DataType.INT32)).toBe(DataType.INT32);
    expect(reconcileTypes(DataType.VARCHAR, null)).toBe(DataType.VARCHAR);
  });

  it('widens numeric types', () => {
    expect(reconcileTypes(DataType.INT32, DataType.FLOAT64)).toBe(DataType.FLOAT64);
    expect(reconcileTypes(DataType.INT32, DataType.INT64)).toBe(DataType.INT64);
  });

  it('falls back to VARCHAR for incompatible types', () => {
    expect(reconcileTypes(DataType.INT32, DataType.VARCHAR)).toBe(DataType.VARCHAR);
    expect(reconcileTypes(DataType.BOOLEAN, DataType.INT32)).toBe(DataType.VARCHAR);
  });
});

describe('inferColumnType', () => {
  it('reconciles a column of values', () => {
    expect(inferColumnType([1, 2, 3])).toBe(DataType.INT32);
    expect(inferColumnType([1, 2.5, null])).toBe(DataType.FLOAT64);
    expect(inferColumnType([null, null])).toBe(DataType.VARCHAR);
    expect(inferColumnType([1, 'a'])).toBe(DataType.VARCHAR);
  });
});

describe('coerceForColumn', () => {
  it('preserves null and coerces by target type', () => {
    expect(coerceForColumn(null, DataType.INT32)).toBe(null);
    expect(coerceForColumn(5, DataType.INT64)).toBe(5n);
    expect(coerceForColumn(7, DataType.VARCHAR)).toBe('7');
    expect(coerceForColumn(new Date(1000), DataType.TIMESTAMP)).toBe(1000n);
  });
});
