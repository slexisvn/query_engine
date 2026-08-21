import { describe, it, expect } from 'vitest';
import { buildChunkZoneMap, isBefore } from '../../src/storage/zone-map.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataType } from '../../src/storage/data-type.js';

function numericColumn(type, values) {
  const column = new Column(type, Math.max(values.length, 1));
  for (let i = 0; i < values.length; i++) column.set(i, values[i]);
  column.length = values.length;
  return column;
}

function textColumn(values) {
  const column = new DictionaryColumn(Math.max(values.length, 1));
  for (let i = 0; i < values.length; i++) column.set(i, values[i]);
  column.length = values.length;
  return column;
}

function chunkOf(columns, size) {
  return new DataChunk(columns, size);
}

describe('buildChunkZoneMap', () => {
  it('records the min and max of the non-NULL values only', () => {
    const chunk = chunkOf([numericColumn(DataType.INT32, [7, null, 3, null, 11])], 5);

    const zoneMap = buildChunkZoneMap(chunk);

    expect(zoneMap.rowCount).toBe(5);
    expect(zoneMap.columns[0].range).toEqual({ min: 3, max: 11 });
    expect(zoneMap.columns[0].hasNulls).toBe(true);
  });

  it('leaves the range absent for an all-NULL column instead of defaulting to a value', () => {
    const chunk = chunkOf([numericColumn(DataType.INT32, [null, null, null])], 3);

    const zoneMap = buildChunkZoneMap(chunk);

    expect(zoneMap.columns[0].range).toBeNull();
    expect(zoneMap.columns[0].hasNulls).toBe(true);
  });

  it('leaves the range absent and reports no NULLs for an empty chunk', () => {
    const chunk = chunkOf([numericColumn(DataType.INT32, [])], 0);

    const zoneMap = buildChunkZoneMap(chunk);

    expect(zoneMap.rowCount).toBe(0);
    expect(zoneMap.columns[0].range).toBeNull();
    expect(zoneMap.columns[0].hasNulls).toBe(false);
  });

  it('reports no NULLs when every value is present', () => {
    const chunk = chunkOf([numericColumn(DataType.FLOAT64, [1.5, -2.25, 0])], 3);

    const zoneMap = buildChunkZoneMap(chunk);

    expect(zoneMap.columns[0].range).toEqual({ min: -2.25, max: 1.5 });
    expect(zoneMap.columns[0].hasNulls).toBe(false);
  });

  it('orders VARCHAR values lexicographically', () => {
    const chunk = chunkOf([textColumn(['pear', 'apple', null, 'quince'])], 4);

    const zoneMap = buildChunkZoneMap(chunk);

    expect(zoneMap.columns[0].range).toEqual({ min: 'apple', max: 'quince' });
    expect(zoneMap.columns[0].hasNulls).toBe(true);
  });

  it('keeps INT64 bounds exact for values that collide as doubles', () => {
    const low = 9007199254740993n;
    const high = 9007199254740995n;
    const chunk = chunkOf([numericColumn(DataType.INT64, [high, low])], 2);

    const zoneMap = buildChunkZoneMap(chunk);

    expect(zoneMap.columns[0].range).toEqual({ min: low, max: high });
  });

  it('summarizes every column of the chunk', () => {
    const chunk = chunkOf([
      numericColumn(DataType.INT32, [4, 9]),
      textColumn(['b', 'a']),
    ], 2);

    const zoneMap = buildChunkZoneMap(chunk);

    expect(zoneMap.columns).toHaveLength(2);
    expect(zoneMap.columns[0].range).toEqual({ min: 4, max: 9 });
    expect(zoneMap.columns[1].range).toEqual({ min: 'a', max: 'b' });
  });

  it('summarizes only the rows a selection vector keeps', () => {
    const chunk = chunkOf([numericColumn(DataType.INT32, [1, 50, 2, 99, 3])], 5);
    chunk.setSelectionVector(new Uint32Array([0, 2, 4]), 3);

    const zoneMap = buildChunkZoneMap(chunk);

    expect(zoneMap.rowCount).toBe(3);
    expect(zoneMap.columns[0].range).toEqual({ min: 1, max: 3 });
  });
});

describe('isBefore', () => {
  it('compares bigints without going through double precision', () => {
    expect(isBefore(9007199254740993n, 9007199254740995n)).toBe(true);
    expect(isBefore(9007199254740995n, 9007199254740993n)).toBe(false);
  });

  it('compares strings by UTF-16 code unit', () => {
    expect(isBefore('Z', 'a')).toBe(true);
    expect(isBefore('abc', 'abd')).toBe(true);
  });

  it('compares booleans as false before true', () => {
    expect(isBefore(false, true)).toBe(true);
    expect(isBefore(true, false)).toBe(false);
  });
});
