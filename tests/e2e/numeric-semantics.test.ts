import { describe, it, expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { DataType } from '../../src/storage/data-type.js';

const INT32_NEAR_MAX = 2000000000;

async function runOn(rows, schema, sql) {
  const engine = createEngine();
  registerTable(engine, 'T', rows, schema);
  registerTable(engine, 'E0', [{ Z: 1 }]);
  const result = await engine.run(sql);
  engine.close();
  return result.rows;
}

async function scalar(sql) {
  return runOn([{ Z: 1 }], null, sql);
}

const INTS = [{ N: 7 }, { N: -7 }, { N: 0 }];
const INT_SCHEMA = [{ name: 'N', dataType: DataType.INT32 }];

const BIG_INTS = [{ N: INT32_NEAR_MAX }, { N: INT32_NEAR_MAX }, { N: INT32_NEAR_MAX }];

describe('numeric semantics', () => {
  describe('division keeps its fraction', () => {
    it('divides two integer columns without truncating', async () => {
      const rows = await runOn([{ A: 7, B: 2 }], [
        { name: 'A', dataType: DataType.INT32 },
        { name: 'B', dataType: DataType.INT32 },
      ], 'SELECT A / B AS X FROM T');
      expect(rows).toEqual([{ X: 3.5 }]);
    });

    it('divides an integer column by an integer literal without truncating', async () => {
      expect(await runOn(INTS, INT_SCHEMA, 'SELECT N / 2 AS X FROM T WHERE N = 7')).toEqual([{ X: 3.5 }]);
    });

    it('keeps the fraction for negative operands', async () => {
      expect(await runOn(INTS, INT_SCHEMA, 'SELECT N / 2 AS X FROM T WHERE N = -7')).toEqual([{ X: -3.5 }]);
    });

    it('agrees with the same division done on literals', async () => {
      const onColumn = await runOn(INTS, INT_SCHEMA, 'SELECT N / 4 AS X FROM T WHERE N = 7');
      const onLiterals = await scalar('SELECT 7 / 4 AS X FROM E0');
      expect(onColumn).toEqual(onLiterals);
    });

    it('divides by zero to NULL rather than truncating', async () => {
      expect(await runOn(INTS, INT_SCHEMA, 'SELECT N / 0 AS X FROM T WHERE N = 7')).toEqual([{ X: null }]);
    });

    it('leaves modulo on integers integral', async () => {
      expect(await runOn(INTS, INT_SCHEMA, 'SELECT N % 4 AS X FROM T WHERE N = 7')).toEqual([{ X: 3 }]);
    });
  });

  describe('decimal literals stay decimal', () => {
    it('divides an integer column by a decimal literal', async () => {
      expect(await runOn(INTS, INT_SCHEMA, 'SELECT N / 2.0 AS X FROM T WHERE N = 7')).toEqual([{ X: 3.5 }]);
    });

    it('keeps a decimal literal quotient exact', async () => {
      expect(await scalar('SELECT 1 / 4.0 AS X FROM E0')).toEqual([{ X: 0.25 }]);
    });

    it('adds a decimal literal without dropping the fraction', async () => {
      expect(await runOn(INTS, INT_SCHEMA, 'SELECT N + 0.5 AS X FROM T WHERE N = 7')).toEqual([{ X: 7.5 }]);
    });
  });

  describe('SQRT returns a real number', () => {
    it('takes the root of an integer literal', async () => {
      const rows = await scalar('SELECT SQRT(2) AS X FROM E0');
      expect(rows[0].X).toBeCloseTo(Math.SQRT2, 10);
    });

    it('takes the root of an integer column', async () => {
      const rows = await runOn(INTS, INT_SCHEMA, 'SELECT SQRT(N) AS X FROM T WHERE N = 7');
      expect(rows[0].X).toBeCloseTo(Math.sqrt(7), 10);
    });

    it('still returns exact roots exactly', async () => {
      expect(await scalar('SELECT SQRT(9) AS X FROM E0')).toEqual([{ X: 3 }]);
    });
  });

  describe('integer arithmetic does not wrap', () => {
    it('adds two large INT32 values', async () => {
      const rows = await runOn(BIG_INTS, INT_SCHEMA, 'SELECT N + N AS X FROM T WHERE N > 0 LIMIT 1');
      expect(rows).toEqual([{ X: INT32_NEAR_MAX * 2 }]);
    });

    it('multiplies a large INT32 value', async () => {
      const rows = await runOn(BIG_INTS, INT_SCHEMA, 'SELECT N * 3 AS X FROM T WHERE N > 0 LIMIT 1');
      expect(rows).toEqual([{ X: INT32_NEAR_MAX * 3 }]);
    });

    it('subtracts past the negative INT32 bound', async () => {
      const rows = await runOn([{ N: -INT32_NEAR_MAX }], INT_SCHEMA, 'SELECT N - N - N AS X FROM T');
      expect(rows).toEqual([{ X: INT32_NEAR_MAX }]);
    });
  });

  describe('SUM widens past the INT32 range', () => {
    it('sums large INT32 values without wrapping', async () => {
      expect(await runOn(BIG_INTS, INT_SCHEMA, 'SELECT SUM(N) AS S FROM T')).toEqual([{ S: INT32_NEAR_MAX * 3 }]);
    });

    it('sums per group without wrapping', async () => {
      expect(await runOn(BIG_INTS, INT_SCHEMA, 'SELECT N, SUM(N) AS S FROM T GROUP BY N'))
        .toEqual([{ N: INT32_NEAR_MAX, S: INT32_NEAR_MAX * 3 }]);
    });

    it('agrees with summing the same values cast to BIGINT', async () => {
      const widened = await runOn(BIG_INTS, INT_SCHEMA, 'SELECT SUM(CAST(N AS BIGINT)) AS S FROM T');
      const direct = await runOn(BIG_INTS, INT_SCHEMA, 'SELECT SUM(N) AS S FROM T');
      expect(direct).toEqual(widened);
    });

    it('keeps a float SUM floating', async () => {
      const rows = await runOn([{ N: 0.5 }, { N: 0.25 }], [{ name: 'N', dataType: DataType.FLOAT64 }],
        'SELECT SUM(N) AS S FROM T');
      expect(rows).toEqual([{ S: 0.75 }]);
    });
  });

  describe('CAST of a non-numeric string', () => {
    it('yields NULL rather than zero for letters', async () => {
      expect(await scalar("SELECT CAST('abc' AS INTEGER) AS X FROM E0")).toEqual([{ X: null }]);
    });

    it('yields NULL rather than zero for an empty string', async () => {
      expect(await scalar("SELECT CAST('' AS INTEGER) AS X FROM E0")).toEqual([{ X: null }]);
    });

    it('yields NULL for a non-numeric cast to DOUBLE', async () => {
      expect(await scalar("SELECT CAST('abc' AS DOUBLE) AS X FROM E0")).toEqual([{ X: null }]);
    });

    it('still casts numeric strings', async () => {
      expect(await scalar("SELECT CAST('42' AS INTEGER) AS X FROM E0")).toEqual([{ X: 42 }]);
    });

    it('still casts booleans to integers', async () => {
      expect(await scalar('SELECT CAST(TRUE AS INTEGER) AS X FROM E0')).toEqual([{ X: 1 }]);
    });

    it('does not treat a bad cast as a match', async () => {
      expect(await runOn(INTS, INT_SCHEMA, "SELECT COUNT(*) AS C FROM T WHERE N = CAST('abc' AS INTEGER)"))
        .toEqual([{ C: 0 }]);
    });

    it('yields NULL per row when casting a text column', async () => {
      const rows = await runOn(
        [{ S: '42' }, { S: 'abc' }, { S: '' }, { S: null }],
        [{ name: 'S', dataType: DataType.VARCHAR }],
        'SELECT CAST(S AS INTEGER) AS X FROM T');
      expect(rows).toEqual([{ X: 42 }, { X: null }, { X: null }, { X: null }]);
    });

    it('counts only the rows that really cast to a number', async () => {
      const rows = await runOn(
        [{ S: '1' }, { S: 'abc' }, { S: '3' }],
        [{ name: 'S', dataType: DataType.VARCHAR }],
        'SELECT COUNT(CAST(S AS INTEGER)) AS C, SUM(CAST(S AS INTEGER)) AS S FROM T');
      expect(rows).toEqual([{ C: 2, S: 4 }]);
    });
  });

  describe('REPLACE with an empty search string', () => {
    it('leaves the input untouched', async () => {
      expect(await scalar("SELECT REPLACE('abc', '', 'X') AS X FROM E0")).toEqual([{ X: 'abc' }]);
    });

    it('still replaces a real search string', async () => {
      expect(await scalar("SELECT REPLACE('banana', 'na', 'X') AS X FROM E0")).toEqual([{ X: 'baXX' }]);
    });
  });
});
