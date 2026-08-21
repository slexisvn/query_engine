import { describe, it, expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { DataType } from '../../src/storage/data-type.js';

const PRICE_SCHEMA = [
  { name: 'NAME', dataType: DataType.VARCHAR },
  { name: 'PRICE', dataType: DataType.DECIMAL },
];
const PRICES = [{ NAME: 'a', PRICE: 10.5 }, { NAME: 'b', PRICE: 2.25 }, { NAME: 'c', PRICE: null }];

const WIDTH_SCHEMA = [
  { name: 'I32', dataType: DataType.INT32 },
  { name: 'I64', dataType: DataType.INT64 },
  { name: 'F64', dataType: DataType.FLOAT64 },
];
const WIDTHS = [
  { I32: 1, I64: 1n, F64: 1 },
  { I32: 2, I64: 2n, F64: 2 },
  { I32: 3, I64: 3n, F64: 3 },
];

const TS_SCHEMA = [
  { name: 'ID', dataType: DataType.INT32 },
  { name: 'T', dataType: DataType.TIMESTAMP },
];
const utc = (y, m, d, h = 0, mi = 0, s = 0) => BigInt(Date.UTC(y, m - 1, d, h, mi, s));
const STAMPS = [
  { ID: 1, T: utc(2020, 1, 31, 10, 30, 0) },
  { ID: 2, T: utc(2021, 3, 15, 23, 59, 59) },
  { ID: 3, T: null },
];

async function run(rows, schema, sql) {
  const engine = createEngine();
  registerTable(engine, 'T', rows, schema);
  const result = await engine.run(sql);
  engine.close();
  return result.rows;
}

const iso = (ms) => new Date(Number(ms)).toISOString();

describe('storage type semantics', () => {
  describe('DECIMAL round-trips its real value', () => {
    it('returns the decimal value, not the scaled integer', async () => {
      expect(await run(PRICES, PRICE_SCHEMA, 'SELECT PRICE FROM T ORDER BY NAME'))
        .toEqual([{ PRICE: 10.5 }, { PRICE: 2.25 }, { PRICE: null }]);
    });

    it('sums and averages decimals', async () => {
      expect(await run(PRICES, PRICE_SCHEMA, 'SELECT SUM(PRICE) AS S, AVG(PRICE) AS A FROM T'))
        .toEqual([{ S: 12.75, A: 6.375 }]);
    });

    it('takes MIN and MAX on the decimal scale', async () => {
      expect(await run(PRICES, PRICE_SCHEMA, 'SELECT MIN(PRICE) AS L, MAX(PRICE) AS H FROM T'))
        .toEqual([{ L: 2.25, H: 10.5 }]);
    });

    it('compares against a decimal literal on the real value', async () => {
      expect(await run(PRICES, PRICE_SCHEMA, 'SELECT COUNT(*) AS C FROM T WHERE PRICE > 5')).toEqual([{ C: 1 }]);
      expect(await run(PRICES, PRICE_SCHEMA, 'SELECT COUNT(*) AS C FROM T WHERE PRICE > 500')).toEqual([{ C: 0 }]);
    });

    it('does arithmetic on the real value', async () => {
      expect(await run(PRICES, PRICE_SCHEMA, "SELECT PRICE * 2 AS X FROM T WHERE NAME = 'b'")).toEqual([{ X: 4.5 }]);
    });

    it('casts the real value to text', async () => {
      expect(await run(PRICES, PRICE_SCHEMA, "SELECT CAST(PRICE AS VARCHAR) AS X FROM T WHERE NAME = 'a'"))
        .toEqual([{ X: '10.5' }]);
    });

    it('groups by the real value', async () => {
      const rows = await run([...PRICES, { NAME: 'd', PRICE: 10.5 }], PRICE_SCHEMA,
        'SELECT PRICE, COUNT(*) AS C FROM T GROUP BY PRICE ORDER BY PRICE NULLS LAST');
      expect(rows).toEqual([{ PRICE: 2.25, C: 1 }, { PRICE: 10.5, C: 2 }, { PRICE: null, C: 1 }]);
    });

    it('survives a CTAS round-trip', async () => {
      const engine = createEngine();
      registerTable(engine, 'T', PRICES, PRICE_SCHEMA);
      await engine.run('CREATE TABLE COPIED AS SELECT NAME, PRICE FROM T');
      const rows = (await engine.run('SELECT PRICE FROM COPIED ORDER BY NAME')).rows;
      engine.close();
      expect(rows).toEqual([{ PRICE: 10.5 }, { PRICE: 2.25 }, { PRICE: null }]);
    });
  });

  describe('TIMESTAMP survives computation', () => {
    it('takes MIN and MAX', async () => {
      const rows = await run(STAMPS, TS_SCHEMA, 'SELECT MIN(T) AS L, MAX(T) AS H FROM T');
      expect(iso(rows[0].L)).toBe('2020-01-31T10:30:00.000Z');
      expect(iso(rows[0].H)).toBe('2021-03-15T23:59:59.000Z');
    });

    it('groups by a timestamp', async () => {
      const rows = await run(STAMPS, TS_SCHEMA, 'SELECT COUNT(*) AS C FROM T GROUP BY T');
      expect(rows).toEqual([{ C: 1 }, { C: 1 }, { C: 1 }]);
    });

    it('orders by a timestamp', async () => {
      expect(await run(STAMPS, TS_SCHEMA, 'SELECT ID FROM T ORDER BY T NULLS LAST'))
        .toEqual([{ ID: 1 }, { ID: 2 }, { ID: 3 }]);
    });
  });

  describe('INTERVAL on a TIMESTAMP moves by the named unit', () => {
    const shift = async (amount, unit) => {
      const rows = await run(STAMPS, TS_SCHEMA, `SELECT T + INTERVAL '${amount}' ${unit} AS X FROM T WHERE ID = 1`);
      return iso(rows[0].X);
    };

    it('adds whole days, not milliseconds', async () => {
      expect(await shift(1, 'DAY')).toBe('2020-02-01T10:30:00.000Z');
    });

    it('adds hours, minutes and seconds', async () => {
      expect(await shift(1, 'HOUR')).toBe('2020-01-31T11:30:00.000Z');
      expect(await shift(90, 'MINUTE')).toBe('2020-01-31T12:00:00.000Z');
      expect(await shift(30, 'SECOND')).toBe('2020-01-31T10:30:30.000Z');
    });

    it('adds months keeping the time of day and clamping the day', async () => {
      expect(await shift(1, 'MONTH')).toBe('2020-02-29T10:30:00.000Z');
    });

    it('adds years keeping the time of day', async () => {
      expect(await shift(1, 'YEAR')).toBe('2021-01-31T10:30:00.000Z');
    });

    it('subtracts days', async () => {
      const rows = await run(STAMPS, TS_SCHEMA, "SELECT T - INTERVAL '1' DAY AS X FROM T WHERE ID = 1");
      expect(iso(rows[0].X)).toBe('2020-01-30T10:30:00.000Z');
    });

    it('still moves DATE columns by whole days', async () => {
      const rows = await run([{ D: 18262 }], [{ name: 'D', dataType: DataType.DATE }],
        "SELECT D + INTERVAL '1' DAY AS X FROM T");
      expect(rows).toEqual([{ X: 18263 }]);
    });
  });

  describe('aggregate argument types', () => {
    it('rejects SUM over text instead of yielding NaN', async () => {
      await expect(run([{ S: 'abc' }], [{ name: 'S', dataType: DataType.VARCHAR }], 'SELECT SUM(S) AS S FROM T'))
        .rejects.toThrow(/SUM requires a numeric argument/);
    });

    it('rejects AVG over text', async () => {
      await expect(run([{ S: 'abc' }], [{ name: 'S', dataType: DataType.VARCHAR }], 'SELECT AVG(S) AS A FROM T'))
        .rejects.toThrow(/AVG requires a numeric argument/);
    });

    it('still allows MIN and MAX over text', async () => {
      expect(await run([{ S: 'b' }, { S: 'a' }], [{ name: 'S', dataType: DataType.VARCHAR }],
        'SELECT MIN(S) AS L, MAX(S) AS H FROM T')).toEqual([{ L: 'a', H: 'b' }]);
    });

    it('still allows COUNT over text', async () => {
      expect(await run([{ S: 'b' }, { S: null }], [{ name: 'S', dataType: DataType.VARCHAR }],
        'SELECT COUNT(S) AS C FROM T')).toEqual([{ C: 1 }]);
    });
  });

  describe('integer widths share one value domain', () => {
    const widths = (sql) => run(WIDTHS, WIDTH_SCHEMA, sql);
    const values = (rows, column) => rows.map((row) => Number(row[column])).sort((a, b) => a - b);

    it('deduplicates equal values across INT32 and INT64 in UNION', async () => {
      const rows = await widths('SELECT I32 AS X FROM T UNION SELECT I64 AS X FROM T');
      expect(values(rows, 'X')).toEqual([1, 2, 3]);
    });

    it('intersects equal values across INT32 and INT64', async () => {
      const rows = await widths('SELECT I32 AS X FROM T INTERSECT SELECT I64 AS X FROM T');
      expect(values(rows, 'X')).toEqual([1, 2, 3]);
    });

    it('subtracts equal values across INT32 and INT64', async () => {
      expect(await widths('SELECT I32 AS X FROM T EXCEPT SELECT I64 AS X FROM T')).toEqual([]);
    });

    it('groups equal values across INT32 and INT64 together', async () => {
      const rows = await widths(
        'SELECT X, COUNT(*) AS C FROM (SELECT I32 AS X FROM T UNION ALL SELECT I64 AS X FROM T) U GROUP BY X');
      expect(values(rows, 'X')).toEqual([1, 2, 3]);
      for (const row of rows) expect(Number(row.C)).toBe(2);
    });

    it('collapses equal values across INT32 and INT64 under DISTINCT', async () => {
      const rows = await widths(
        'SELECT DISTINCT X FROM (SELECT I32 AS X FROM T UNION ALL SELECT I64 AS X FROM T) U');
      expect(values(rows, 'X')).toEqual([1, 2, 3]);
    });

    it('sorts a set operation that mixes integer widths', async () => {
      const rows = await widths(
        'SELECT X FROM (SELECT I32 AS X FROM T UNION ALL SELECT I64 AS X FROM T) M ORDER BY X');
      expect(rows.map((row) => Number(row.X))).toEqual([1, 1, 2, 2, 3, 3]);
    });

    it('windows over a set operation that mixes integer widths', async () => {
      const rows = await widths(
        'SELECT X, COUNT(*) OVER (PARTITION BY X) AS C FROM (SELECT I32 AS X FROM T UNION ALL SELECT I64 AS X FROM T) M');
      expect(rows).toHaveLength(6);
      for (const row of rows) expect(Number(row.C)).toBe(2);
    });

    it('joins a set operation that mixes integer widths', async () => {
      expect(await widths(
        'SELECT COUNT(*) AS C FROM (SELECT I32 AS X FROM T UNION ALL SELECT I64 AS X FROM T) M JOIN T ON M.X = T.I32'))
        .toEqual([{ C: 6 }]);
    });

    it('agrees with the comparison operator, which already matched across widths', async () => {
      expect(await widths('SELECT COUNT(*) AS C FROM T a JOIN T b ON a.I32 = b.I64')).toEqual([{ C: 3 }]);
      expect(await widths('SELECT COUNT(*) AS C FROM T WHERE I32 = I64')).toEqual([{ C: 3 }]);
    });

    it('keeps FLOAT64 in the same domain as the integer widths', async () => {
      const rows = await widths('SELECT I64 AS X FROM T UNION SELECT F64 AS X FROM T');
      expect(values(rows, 'X')).toEqual([1, 2, 3]);
    });
  });
});
