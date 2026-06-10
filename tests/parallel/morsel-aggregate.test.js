import { describe, it, expect, afterAll } from 'vitest';
import { MorselAggregate } from '../../src/parallel/morsel-aggregate.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { DataType } from '../../src/storage/data-type.js';

const pool = new MorselAggregate(2, 8);
afterAll(() => pool.close());

function chunkFrom(schema, rows) {
  const cols = schema.map(s => s.dataType === DataType.VARCHAR ? new DictionaryColumn(Math.max(1, rows.length)) : new Column(s.dataType, Math.max(1, rows.length)));
  for (const row of rows) row.forEach((v, i) => cols[i].append(v));
  return new DataChunk(cols, rows.length);
}

function sortRows(rows, keys) {
  return rows.map(r => keys.map(k => r[k] === null || r[k] === undefined ? 'N' : r[k]).join('|')).sort();
}

describe('MorselAggregate', () => {
  const schema = [
    { name: 'g', dataType: DataType.VARCHAR },
    { name: 'n', dataType: DataType.INT32 },
  ];

  it('groups by varchar with SUM/COUNT/MIN/MAX/AVG/COUNT_STAR across morsels', async () => {
    const rows = [];
    for (let i = 0; i < 50; i++) rows.push([i % 2 === 0 ? 'a' : 'b', i]);
    const chunks = [chunkFrom(schema, rows.slice(0, 20)), chunkFrom(schema, rows.slice(20))];
    const spec = {
      filter: [],
      groupCols: [{ col: 'g', out: '__g0' }],
      aggs: [
        { fn: 'sum', col: 'n', out: '__a0' },
        { fn: 'count', col: 'n', out: '__a1' },
        { fn: 'min', col: 'n', out: '__a2' },
        { fn: 'max', col: 'n', out: '__a3' },
        { fn: 'avg', col: 'n', out: '__a4' },
        { fn: 'countStar', col: null, out: '__a5' },
      ],
    };
    const got = await pool.run(chunks, schema, spec);
    const byG = Object.fromEntries(got.map(r => [r.__g0, r]));
    const evens = Array.from({ length: 25 }, (_, k) => 2 * k);
    const odds = Array.from({ length: 25 }, (_, k) => 2 * k + 1);
    const sum = a => a.reduce((s, x) => s + x, 0);
    expect(byG.a.__a0).toBe(sum(evens));
    expect(byG.a.__a1).toBe(25);
    expect(byG.a.__a2).toBe(0);
    expect(byG.a.__a3).toBe(48);
    expect(byG.a.__a4).toBeCloseTo(sum(evens) / 25);
    expect(byG.a.__a5).toBe(25);
    expect(byG.b.__a2).toBe(1);
    expect(byG.b.__a3).toBe(49);
  });

  it('treats NULL group key as its own group and skips NULL agg inputs', async () => {
    const rows = [['a', 10], [null, 5], ['a', null], [null, null], ['a', 20]];
    const chunks = [chunkFrom(schema, rows)];
    const spec = {
      filter: [],
      groupCols: [{ col: 'g', out: '__g0' }],
      aggs: [{ fn: 'sum', col: 'n', out: '__a0' }, { fn: 'count', col: 'n', out: '__a1' }, { fn: 'countStar', col: null, out: '__a2' }],
    };
    const got = await pool.run(chunks, schema, spec);
    expect(sortRows(got, ['__g0', '__a0', '__a1', '__a2'])).toEqual(
      sortRows([{ __g0: 'a', __a0: 30, __a1: 2, __a2: 3 }, { __g0: null, __a0: 5, __a1: 1, __a2: 2 }], ['__g0', '__a0', '__a1', '__a2'])
    );
  });

  it('SUM/AVG over an all-null group return null', async () => {
    const rows = [['x', null], ['x', null]];
    const spec = { filter: [], groupCols: [{ col: 'g', out: '__g0' }], aggs: [{ fn: 'sum', col: 'n', out: '__a0' }, { fn: 'avg', col: 'n', out: '__a1' }] };
    const got = await pool.run([chunkFrom(schema, rows)], schema, spec);
    expect(got[0].__a0).toBeNull();
    expect(got[0].__a1).toBeNull();
  });

  it('applies a numeric filter with 3VL (null fails the predicate)', async () => {
    const rows = [['a', 1], ['a', 5], ['a', null], ['b', 9]];
    const spec = { filter: [{ col: 'n', op: '>', value: 3 }], groupCols: [{ col: 'g', out: '__g0' }], aggs: [{ fn: 'countStar', col: null, out: '__a0' }] };
    const got = await pool.run([chunkFrom(schema, rows)], schema, spec);
    const byG = Object.fromEntries(got.map(r => [r.__g0, r.__a0]));
    expect(byG.a).toBe(1);
    expect(byG.b).toBe(1);
  });

  it('returns empty array for empty grouped input', async () => {
    expect(await pool.run([], schema, { filter: [], groupCols: [{ col: 'g', out: '__g0' }], aggs: [] })).toEqual([]);
  });

  it('global aggregate over zero rows returns one row (count 0, sum null)', async () => {
    const spec = { filter: [], groupCols: [], aggs: [{ fn: 'countStar', col: null, out: '__a0' }, { fn: 'sum', col: 'n', out: '__a1' }, { fn: 'max', col: 'n', out: '__a2' }] };
    const empty = await pool.run([], schema, spec);
    expect(empty).toEqual([{ __a0: 0, __a1: null, __a2: null }]);
  });

  it('global aggregate whose internal filter removes all rows still returns one row', async () => {
    const rows = [['a', 1], ['b', 2]];
    const spec = { filter: [{ col: 'n', op: '>', value: 100 }], groupCols: [], aggs: [{ fn: 'countStar', col: null, out: '__a0' }, { fn: 'min', col: 'n', out: '__a1' }] };
    const got = await pool.run([chunkFrom(schema, rows)], schema, spec);
    expect(got).toEqual([{ __a0: 0, __a1: null }]);
  });

  it('falls back (null) when a group column type is unsupported', async () => {
    const s = [{ name: 'g', dataType: DataType.INT64 }, { name: 'n', dataType: DataType.INT32 }];
    const cols = [new Column(DataType.INT64, 2), new Column(DataType.INT32, 2)];
    cols[0].append(1n); cols[0].append(2n); cols[1].append(3); cols[1].append(4);
    const chunk = new DataChunk(cols, 2);
    const got = await pool.run([chunk], s, { filter: [], groupCols: [{ col: 'g', out: '__g0' }], aggs: [{ fn: 'sum', col: 'n', out: '__a0' }] });
    expect(got).toBeNull();
  });
});
