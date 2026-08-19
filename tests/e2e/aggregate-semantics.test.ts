import { describe, it, expect } from 'vitest';
import { JOIN_OPERATORS, runQuery, runQueryOn, sortedRows } from '../helpers/sql-oracle.js';

describe('aggregate semantics', () => {
  describe('GROUP BY on expressions', () => {
    it('projects an arithmetic grouping expression', async () => {
      const rows = await runQuery('SELECT SAL/100 AS G, COUNT(*) AS C FROM EMP WHERE SAL IS NOT NULL GROUP BY SAL/100');
      expect(sortedRows(rows)).toEqual(sortedRows([
        { G: 1, C: 1 }, { G: 2, C: 1 }, { G: 3, C: 1 }, { G: 5, C: 1 },
      ]));
    });

    it('projects a CASE grouping expression', async () => {
      const rows = await runQuery(
        "SELECT CASE WHEN SAL>200 THEN 'h' ELSE 'l' END AS G, COUNT(*) AS C FROM EMP WHERE SAL IS NOT NULL "
        + "GROUP BY CASE WHEN SAL>200 THEN 'h' ELSE 'l' END");
      expect(sortedRows(rows)).toEqual(sortedRows([{ G: 'h', C: 2 }, { G: 'l', C: 2 }]));
    });

    it('filters on a grouping expression in HAVING', async () => {
      const rows = await runQuery('SELECT SAL/100 AS G, COUNT(*) AS C FROM EMP WHERE SAL IS NOT NULL GROUP BY SAL/100 HAVING SAL/100 > 2');
      expect(sortedRows(rows)).toEqual(sortedRows([{ G: 3, C: 1 }, { G: 5, C: 1 }]));
    });

    it('keeps plain column grouping working', async () => {
      const rows = await runQuery('SELECT DEPT, COUNT(*) AS C FROM EMP GROUP BY DEPT');
      expect(sortedRows(rows)).toEqual(sortedRows([
        { DEPT: 10, C: 2 }, { DEPT: 20, C: 2 }, { DEPT: null, C: 1 },
      ]));
    });
  });

  describe('COUNT(*) over an outer join', () => {
    for (const operator of JOIN_OPERATORS) {
      it(`counts every produced row on ${operator}`, async () => {
        const rows = await runQueryOn(operator, 'SELECT COUNT(*) AS C FROM DEPT D LEFT JOIN EMP E ON E.DEPT = D.DEPT');
        expect(rows).toEqual([{ C: 5 }]);
      });

      it(`counts grouped rows on ${operator}`, async () => {
        const rows = await runQueryOn(operator,
          'SELECT D.DNAME AS N, COUNT(*) AS C FROM DEPT D LEFT JOIN EMP E ON E.DEPT = D.DEPT GROUP BY D.DNAME');
        expect(sortedRows(rows)).toEqual(sortedRows([
          { N: 'sales', C: 2 }, { N: 'eng', C: 2 }, { N: 'hr', C: 1 },
        ]));
      });

      it(`counts a self outer join on ${operator}`, async () => {
        const rows = await runQueryOn(operator, 'SELECT COUNT(*) AS C FROM T A LEFT JOIN T B ON A.K = B.K');
        expect(rows).toEqual([{ C: 10 }]);
      });

      it(`still counts an inner join correctly on ${operator}`, async () => {
        const rows = await runQueryOn(operator, 'SELECT COUNT(*) AS C FROM DEPT D JOIN EMP E ON E.DEPT = D.DEPT');
        expect(rows).toEqual([{ C: 4 }]);
      });

      it(`counts a referenced right column on ${operator}`, async () => {
        const rows = await runQueryOn(operator,
          'SELECT D.DNAME AS N, COUNT(E.ID) AS C FROM DEPT D LEFT JOIN EMP E ON E.DEPT = D.DEPT GROUP BY D.DNAME');
        expect(sortedRows(rows)).toEqual(sortedRows([
          { N: 'sales', C: 2 }, { N: 'eng', C: 2 }, { N: 'hr', C: 0 },
        ]));
      });
    }
  });

  describe('DISTINCT aggregates', () => {
    it('sums each distinct value once', async () => {
      const rows = await runQuery('SELECT SUM(DISTINCT V) AS S FROM T');
      expect(rows).toEqual([{ S: 11 }]);
    });

    it('averages over distinct values only', async () => {
      const rows = await runQuery('SELECT AVG(DISTINCT V) AS A FROM T');
      expect(rows).toEqual([{ A: 2.75 }]);
    });

    it('keeps COUNT DISTINCT working', async () => {
      const rows = await runQuery('SELECT COUNT(DISTINCT V) AS C FROM T');
      expect(rows).toEqual([{ C: 4 }]);
    });

    it('keeps the non-distinct aggregates unchanged', async () => {
      const rows = await runQuery('SELECT SUM(V) AS S, AVG(V) AS A, COUNT(V) AS C FROM T');
      expect(rows).toEqual([{ S: 14, A: 2.8, C: 5 }]);
    });

    it('applies DISTINCT per group', async () => {
      const rows = await runQuery('SELECT K, SUM(DISTINCT V) AS S FROM T GROUP BY K');
      expect(sortedRows(rows)).toEqual(sortedRows([
        { K: 'a', S: 3 }, { K: 'b', S: 3 }, { K: 'c', S: null }, { K: null, S: 5 },
      ]));
    });
  });

  describe('MIN and MAX preserve the input type', () => {
    it('compares VARCHAR values as text', async () => {
      const rows = await runQuery('SELECT MIN(K) AS MN, MAX(K) AS MX FROM T');
      expect(rows).toEqual([{ MN: 'a', MX: 'c' }]);
    });

    it('keeps numeric MIN and MAX numeric', async () => {
      const rows = await runQuery('SELECT MIN(SAL) AS MN, MAX(SAL) AS MX FROM EMP');
      expect(rows).toEqual([{ MN: 100, MX: 500 }]);
    });

    it('groups VARCHAR extremes', async () => {
      const rows = await runQuery('SELECT DEPT, MAX(NAME) AS MX FROM EMP GROUP BY DEPT');
      expect(sortedRows(rows)).toEqual(sortedRows([
        { DEPT: 10, MX: 'bob' }, { DEPT: 20, MX: 'dave' }, { DEPT: null, MX: 'eve' },
      ]));
    });
  });
});
