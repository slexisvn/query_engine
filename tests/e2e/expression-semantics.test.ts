import { describe, it, expect } from 'vitest';
import { runQuery, runQueryColumnTypes, sortedRows } from '../helpers/sql-oracle.js';

describe('expression and window semantics', () => {
  describe('CASE result type', () => {
    it('keeps the operand type when the first branch is NULL', async () => {
      const rows = await runQuery('SELECT CASE WHEN DEPT = 10 THEN NULL ELSE DEPT END AS D FROM EMP');
      expect(rows).toEqual([
        { D: null }, { D: null }, { D: 20 }, { D: 20 }, { D: null },
      ]);
    });

    it('agrees with NULLIF on the same expression', async () => {
      const withCase = await runQuery('SELECT CASE WHEN DEPT = 10 THEN NULL ELSE DEPT END AS D FROM EMP');
      const withNullif = await runQuery('SELECT NULLIF(DEPT, 10) AS D FROM EMP');
      expect(withCase).toEqual(withNullif);
    });

    it('keeps a VARCHAR CASE as text', async () => {
      const rows = await runQuery("SELECT CASE WHEN DEPT = 10 THEN 'ten' ELSE 'other' END AS D FROM EMP WHERE ID = 1");
      expect(rows).toEqual([{ D: 'ten' }]);
    });
  });

  describe('temporal arithmetic types', () => {
    it('types DATE + INTERVAL as DATE in either operand order', async () => {
      const forward = await runQuery("SELECT DATE '2020-01-01' + INTERVAL '1' DAY AS D FROM E0");
      const reversed = await runQuery("SELECT INTERVAL '1' DAY + DATE '2020-01-01' AS D FROM E0");
      expect(forward).toEqual([{ D: 18263 }]);
      expect(reversed).toEqual(forward);
      expect(await runQueryColumnTypes("SELECT D + INTERVAL '1' DAY AS X FROM DT")).toEqual(['DATE']);
      expect(await runQueryColumnTypes("SELECT INTERVAL '1' DAY + D AS X FROM DT")).toEqual(['DATE']);
    });

    it('keeps a plain DATE column typed as DATE', async () => {
      expect(await runQueryColumnTypes('SELECT D FROM DT')).toEqual(['DATE']);
    });

    it('shifts a DATE column by an interval from either side', async () => {
      expect(await runQuery("SELECT D + INTERVAL '1' DAY AS X FROM DT"))
        .toEqual(await runQuery("SELECT INTERVAL '1' DAY + D AS X FROM DT"));
    });

    it('extracts calendar fields from shifted dates', async () => {
      const rows = await runQuery("SELECT EXTRACT(MONTH FROM DATE '2020-01-31' + INTERVAL '1' MONTH) AS M FROM E0");
      expect(rows).toEqual([{ M: 2 }]);
    });

    it('types the difference of two dates as a day count', async () => {
      const rows = await runQuery("SELECT D - DATE '2020-01-01' AS X FROM DT");
      expect(rows).toEqual([{ X: 0 }, { X: 30 }]);
      expect(await runQueryColumnTypes("SELECT D - DATE '2020-01-01' AS X FROM DT")).toEqual(['INT32']);
    });
  });

  describe('LAG and LEAD defaults', () => {
    it('uses a negative literal default', async () => {
      const rows = await runQuery('SELECT ID, LAG(ID, 1, -1) OVER (ORDER BY ID) AS P FROM EMP');
      expect(rows).toEqual([
        { ID: 1, P: -1 }, { ID: 2, P: 1 }, { ID: 3, P: 2 }, { ID: 4, P: 3 }, { ID: 5, P: 4 },
      ]);
    });

    it('uses a computed default expression', async () => {
      const rows = await runQuery('SELECT ID, LAG(ID, 1, ID * 10) OVER (ORDER BY ID) AS P FROM EMP');
      expect(rows[0]).toEqual({ ID: 1, P: 10 });
    });

    it('applies the default for LEAD past the end', async () => {
      const rows = await runQuery('SELECT ID, LEAD(ID, 2, -9) OVER (ORDER BY ID) AS P FROM EMP');
      expect(rows).toEqual([
        { ID: 1, P: 3 }, { ID: 2, P: 4 }, { ID: 3, P: 5 }, { ID: 4, P: -9 }, { ID: 5, P: -9 },
      ]);
    });

    it('keeps null as the default when none is given', async () => {
      const rows = await runQuery('SELECT ID, LAG(ID) OVER (ORDER BY ID) AS P FROM EMP');
      expect(rows[0]).toEqual({ ID: 1, P: null });
    });
  });

  describe('window frames', () => {
    it('accumulates over ROWS UNBOUNDED PRECEDING', async () => {
      const rows = await runQuery('SELECT ID, SUM(SAL) OVER (ORDER BY ID ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS S FROM EMP');
      expect(rows).toEqual([
        { ID: 1, S: 100 }, { ID: 2, S: 300 }, { ID: 3, S: 600 }, { ID: 4, S: 600 }, { ID: 5, S: 1100 },
      ]);
    });

    it('slides a bounded ROWS frame', async () => {
      const rows = await runQuery('SELECT ID, SUM(SAL) OVER (ORDER BY ID ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS S FROM EMP');
      expect(rows).toEqual([
        { ID: 1, S: 300 }, { ID: 2, S: 600 }, { ID: 3, S: 500 }, { ID: 4, S: 800 }, { ID: 5, S: 500 },
      ]);
    });

    it('counts rows in a bounded frame', async () => {
      const rows = await runQuery('SELECT ID, COUNT(*) OVER (ORDER BY ID ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS C FROM EMP');
      expect(rows).toEqual([
        { ID: 1, C: 1 }, { ID: 2, C: 2 }, { ID: 3, C: 2 }, { ID: 4, C: 2 }, { ID: 5, C: 2 },
      ]);
    });

    it('slides MIN over a bounded frame', async () => {
      const rows = await runQuery('SELECT ID, MIN(SAL) OVER (ORDER BY ID ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS M FROM EMP');
      expect(rows).toEqual([
        { ID: 1, M: 100 }, { ID: 2, M: 100 }, { ID: 3, M: 200 }, { ID: 4, M: 300 }, { ID: 5, M: 500 },
      ]);
    });

    it('gives peers the same value under the default RANGE frame', async () => {
      const rows = await runQuery('SELECT K, V, SUM(V) OVER (ORDER BY K) AS S FROM T');
      expect(sortedRows(rows)).toEqual(sortedRows([
        { K: 'a', V: 1, S: 3 }, { K: 'a', V: 2, S: 3 },
        { K: 'b', V: 3, S: 9 }, { K: 'b', V: 3, S: 9 },
        { K: 'c', V: null, S: 9 }, { K: null, V: 5, S: 14 },
      ]));
    });

    it('separates peers under an explicit ROWS frame', async () => {
      const rows = await runQuery('SELECT V, SUM(V) OVER (ORDER BY K, V ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS S FROM T');
      expect(rows.map(row => row.S)).toEqual([1, 3, 6, 9, 9, 14]);
    });

    it('covers the whole partition without ORDER BY', async () => {
      const rows = await runQuery('SELECT ID, SUM(SAL) OVER () AS S FROM EMP');
      expect(rows.every(row => row.S === 1100)).toBe(true);
    });

    it('rejects RANGE frames with an offset', async () => {
      await expect(runQuery('SELECT ID, SUM(SAL) OVER (ORDER BY ID RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS S FROM EMP'))
        .rejects.toThrow(/RANGE frames/);
    });
  });

  describe('IS TRUE and IS FALSE', () => {
    it('counts only true predicates', async () => {
      const rows = await runQuery('SELECT COUNT(*) AS C FROM EMP WHERE (SAL > 100) IS TRUE');
      expect(rows).toEqual([{ C: 3 }]);
    });

    it('counts only false predicates', async () => {
      const rows = await runQuery('SELECT COUNT(*) AS C FROM EMP WHERE (SAL > 100) IS FALSE');
      expect(rows).toEqual([{ C: 1 }]);
    });

    it('treats unknown as not true', async () => {
      const rows = await runQuery('SELECT COUNT(*) AS C FROM EMP WHERE (SAL > 100) IS NOT TRUE');
      expect(rows).toEqual([{ C: 2 }]);
    });

    it('treats unknown as not false', async () => {
      const rows = await runQuery('SELECT COUNT(*) AS C FROM EMP WHERE (SAL > 100) IS NOT FALSE');
      expect(rows).toEqual([{ C: 4 }]);
    });

    it('keeps IS NULL working alongside', async () => {
      const rows = await runQuery('SELECT COUNT(*) AS C FROM EMP WHERE SAL IS NULL');
      expect(rows).toEqual([{ C: 1 }]);
    });
  });

  describe('simple CASE', () => {
    it('picks the branch whose value equals the operand, not the first branch', async () => {
      const rows = await runQuery("SELECT CASE 2 WHEN 1 THEN 'a' WHEN 2 THEN 'b' ELSE 'c' END AS G FROM E0");
      expect(rows).toEqual([{ G: 'b' }]);
    });

    it('compares the operand against every branch of a column CASE', async () => {
      const rows = await runQuery("SELECT CASE DEPT WHEN 10 THEN 'sales' WHEN 20 THEN 'eng' ELSE 'other' END AS G FROM EMP");
      expect(rows.map(row => row.G)).toEqual(['sales', 'sales', 'eng', 'eng', 'other']);
    });

    it('agrees with the equivalent searched CASE', async () => {
      const simple = await runQuery("SELECT CASE DEPT WHEN 10 THEN 'sales' ELSE 'other' END AS G FROM EMP");
      const searched = await runQuery("SELECT CASE WHEN DEPT = 10 THEN 'sales' ELSE 'other' END AS G FROM EMP");
      expect(simple).toEqual(searched);
    });

    it('falls through to ELSE when the operand is NULL', async () => {
      const rows = await runQuery("SELECT CASE DEPT WHEN 10 THEN 'ten' ELSE 'other' END AS G FROM EMP WHERE ID = 5");
      expect(rows).toEqual([{ G: 'other' }]);
    });

    it('yields NULL when no branch matches and there is no ELSE', async () => {
      const rows = await runQuery("SELECT CASE DEPT WHEN 99 THEN 'x' END AS G FROM EMP WHERE ID = 1");
      expect(rows).toEqual([{ G: null }]);
    });

    it('matches string operands exactly', async () => {
      const rows = await runQuery("SELECT CASE NAME WHEN 'bob' THEN 'B' ELSE '-' END AS G FROM EMP");
      expect(rows.map(row => row.G)).toEqual(['-', 'B', '-', '-', '-']);
    });
  });

  describe('LIKE is case-sensitive', () => {
    it('does not match a pattern that differs only in case', async () => {
      expect(await runQuery("SELECT ID FROM EMP WHERE NAME LIKE 'A%'")).toEqual([]);
      expect(await runQuery("SELECT ID FROM EMP WHERE NAME LIKE 'ALICE'")).toEqual([]);
    });

    it('still matches the exact case', async () => {
      expect(await runQuery("SELECT ID FROM EMP WHERE NAME LIKE 'a%'")).toEqual([{ ID: 1 }]);
    });

    it('treats regex metacharacters in the pattern as literals', async () => {
      expect(await runQuery("SELECT ID FROM EMP WHERE NAME LIKE '.*'")).toEqual([]);
    });
  });

  describe('function resolution', () => {
    it('rejects an unregistered function instead of returning NULL', async () => {
      await expect(runQuery('SELECT NOSUCHFN(1) AS R FROM E0')).rejects.toThrow(/Unknown function: NOSUCHFN/);
    });

    it('rejects a misspelled function rather than silently yielding NULL', async () => {
      await expect(runQuery("SELECT CONCAT('a', 'b') AS R FROM E0")).rejects.toThrow(/Unknown function: CONCAT/);
    });

    it('rejects too many arguments', async () => {
      await expect(runQuery("SELECT UPPER('a', 'b') AS R FROM E0")).rejects.toThrow(/UPPER expects 1 argument/);
    });

    it('rejects too few arguments', async () => {
      await expect(runQuery('SELECT LENGTH() AS R FROM E0')).rejects.toThrow(/LENGTH expects 1 argument/);
    });

    it('accepts a variadic function at any arity', async () => {
      expect(await runQuery('SELECT COALESCE(NULL, NULL, 7) AS R FROM E0')).toEqual([{ R: 7 }]);
    });
  });
});
