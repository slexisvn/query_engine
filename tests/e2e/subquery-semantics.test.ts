import { describe, it, expect } from 'vitest';
import { JOIN_OPERATORS, NON_EQUI_JOIN_OPERATORS, runQuery, runQueryOn, sortedRows } from '../helpers/sql-oracle.js';

describe('subquery and derived table semantics', () => {
  for (const operator of JOIN_OPERATORS) {
    describe(operator, () => {
      it('joins a filtered derived table against a base table', async () => {
        const rows = await runQueryOn(operator,
          'SELECT E.ID AS I FROM (SELECT ID, DEPT FROM EMP WHERE SAL > 150) E JOIN DEPT D ON E.DEPT = D.DEPT');
        expect(sortedRows(rows)).toEqual(sortedRows([{ I: 2 }, { I: 3 }]));
      });

      it('joins a filtered derived table whose columns were renamed', async () => {
        const rows = await runQueryOn(operator,
          'SELECT E.I2 AS I FROM (SELECT ID AS I2, DEPT AS D2 FROM EMP WHERE SAL > 150) E JOIN DEPT D ON E.D2 = D.DEPT');
        expect(sortedRows(rows)).toEqual(sortedRows([{ I: 2 }, { I: 3 }]));
      });

      it('resolves IN (subquery) when outer and inner columns have different names', async () => {
        const rows = await runQueryOn(operator, 'SELECT ID FROM EMP WHERE MGR IN (SELECT ID FROM EMP)');
        expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 2 }, { ID: 3 }, { ID: 4 }, { ID: 5 }]));
      });

      it('resolves IN (subquery) in the opposite direction', async () => {
        const rows = await runQueryOn(operator, 'SELECT ID FROM EMP WHERE ID IN (SELECT MGR FROM EMP)');
        expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 1 }, { ID: 2 }]));
      });

      it('keeps IN (subquery) empty when no value matches', async () => {
        const rows = await runQueryOn(operator, 'SELECT ID FROM EMP WHERE MGR IN (SELECT DEPT FROM DEPT)');
        expect(rows).toEqual([]);
      });

      it('evaluates a correlated scalar subquery once per outer row', async () => {
        const rows = await runQueryOn(operator,
          'SELECT D.DNAME AS N, (SELECT COUNT(*) FROM EMP E WHERE E.DEPT = D.DEPT) AS C FROM DEPT D');
        expect(sortedRows(rows)).toEqual(sortedRows([
          { N: 'sales', C: 2 },
          { N: 'eng', C: 2 },
          { N: 'hr', C: 0 },
        ]));
      });

      it('returns zero, not null, for a correlated COUNT over an empty group', async () => {
        const rows = await runQueryOn(operator,
          'SELECT E.ID AS I, (SELECT COUNT(*) FROM EMP X WHERE X.MGR = E.ID) AS N FROM EMP E');
        expect(sortedRows(rows)).toEqual(sortedRows([
          { I: 1, N: 2 }, { I: 2, N: 2 }, { I: 3, N: 0 }, { I: 4, N: 0 }, { I: 5, N: 0 },
        ]));
      });

      it('projects a correlated non-aggregate scalar subquery', async () => {
        const rows = await runQueryOn(operator,
          'SELECT E.ID AS I, (SELECT NAME FROM EMP X WHERE X.ID = E.MGR) AS M FROM EMP E');
        expect(sortedRows(rows)).toEqual(sortedRows([
          { I: 1, M: null }, { I: 2, M: 'alice' }, { I: 3, M: 'alice' },
          { I: 4, M: 'bob' }, { I: 5, M: 'bob' },
        ]));
      });

      it('keeps rows for NOT IN when the subquery has no nulls', async () => {
        const rows = await runQueryOn(operator,
          'SELECT DNAME FROM DEPT WHERE DEPT NOT IN (SELECT DEPT FROM EMP WHERE DEPT IS NOT NULL)');
        expect(rows).toEqual([{ DNAME: 'hr' }]);
      });

      it('drops every row for NOT IN when the subquery contains a null', async () => {
        const rows = await runQueryOn(operator,
          'SELECT DNAME FROM DEPT WHERE DEPT NOT IN (SELECT DEPT FROM EMP)');
        expect(rows).toEqual([]);
      });

      it('honours the left disjunct when a NOT IN subquery sits under OR', async () => {
        const rows = await runQueryOn(operator,
          'SELECT ID FROM EMP WHERE DEPT IS NULL OR DEPT NOT IN (SELECT DEPT FROM DEPT)');
        expect(rows).toEqual([{ ID: 5 }]);
      });

      it('exposes inner correlation columns to a correlated IN subquery', async () => {
        const rows = await runQueryOn(operator,
          'SELECT E.ID AS I FROM EMP E WHERE E.MGR IN (SELECT X.ID FROM EMP X WHERE X.DEPT = E.DEPT)');
        expect(rows).toEqual([{ I: 2 }]);
      });

      it('exposes inner correlation columns to a correlated IN subquery under OR', async () => {
        const rows = await runQueryOn(operator,
          'SELECT E.ID AS I FROM EMP E WHERE E.DEPT IS NULL OR E.MGR IN (SELECT X.ID FROM EMP X WHERE X.DEPT = E.DEPT)');
        expect(sortedRows(rows)).toEqual(sortedRows([{ I: 2 }, { I: 5 }]));
      });

      it('honours an EXISTS subquery under OR', async () => {
        const rows = await runQueryOn(operator,
          "SELECT ID FROM EMP WHERE DEPT IS NULL OR EXISTS (SELECT 1 FROM DEPT D WHERE D.DEPT = EMP.DEPT AND D.DNAME = 'eng')");
        expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 3 }, { ID: 4 }, { ID: 5 }]));
      });

    });
  }

  for (const operator of NON_EQUI_JOIN_OPERATORS) {
    describe(`${operator} (no equi-join keys)`, () => {
      it('returns null, not a dropped row, for a scalar subquery with no rows', async () => {
        const rows = await runQueryOn(operator, "SELECT (SELECT V FROM T WHERE K = 'zzz') AS S FROM E0");
        expect(rows).toEqual([{ S: null }]);
      });

      it('evaluates > ANY against every subquery row', async () => {
        const rows = await runQueryOn(operator,
          'SELECT ID FROM EMP WHERE SAL > ANY (SELECT SAL FROM EMP WHERE DEPT = 10)');
        expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 2 }, { ID: 3 }, { ID: 5 }]));
      });

      it('evaluates > ALL against every subquery row', async () => {
        const rows = await runQueryOn(operator,
          'SELECT ID FROM EMP WHERE SAL > ALL (SELECT SAL FROM EMP WHERE DEPT = 10)');
        expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 3 }, { ID: 5 }]));
      });

      it('treats a null in the subquery as unknown for >= ALL', async () => {
        const rows = await runQueryOn(operator,
          'SELECT ID FROM EMP WHERE SAL >= ALL (SELECT SAL FROM EMP WHERE DEPT = 20)');
        expect(rows).toEqual([]);
      });

      it('treats ALL over an empty subquery as true', async () => {
        const rows = await runQueryOn(operator,
          'SELECT ID FROM EMP WHERE SAL > ALL (SELECT SAL FROM EMP WHERE DEPT = 99)');
        expect(sortedRows(rows)).toEqual(sortedRows([
          { ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }, { ID: 5 },
        ]));
      });

      it('treats ANY over an empty subquery as false', async () => {
        const rows = await runQueryOn(operator,
          'SELECT ID FROM EMP WHERE SAL > ANY (SELECT SAL FROM EMP WHERE DEPT = 99)');
        expect(rows).toEqual([]);
      });

      it('keeps SOME as a synonym for ANY', async () => {
        const rows = await runQueryOn(operator,
          'SELECT ID FROM EMP WHERE SAL > SOME (SELECT SAL FROM EMP WHERE DEPT = 20)');
        expect(rows).toEqual([{ ID: 5 }]);
      });
    });
  }

  it('reads a filtered derived table without a join', async () => {
    const rows = await runQuery('SELECT ID, DEPT FROM (SELECT ID, DEPT FROM EMP WHERE SAL > 150) E');
    expect(sortedRows(rows)).toEqual(sortedRows([
      { ID: 2, DEPT: 10 }, { ID: 3, DEPT: 20 }, { ID: 5, DEPT: null },
    ]));
  });

  it('still uses the literal list path for IN with constants', async () => {
    const rows = await runQuery('SELECT ID FROM EMP WHERE MGR IN (1, 2)');
    expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 2 }, { ID: 3 }, { ID: 4 }, { ID: 5 }]));
  });

  it('still uses the literal list path for NOT IN with constants', async () => {
    const rows = await runQuery('SELECT DNAME FROM DEPT WHERE DEPT NOT IN (10, 20)');
    expect(rows).toEqual([{ DNAME: 'hr' }]);
  });

  it('matches a computed outer expression against an IN subquery', async () => {
    const rows = await runQuery('SELECT ID FROM EMP WHERE SAL - 100 IN (SELECT SAL FROM EMP)');
    expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 2 }, { ID: 3 }]));
  });

  it('rejects a quantified comparison with an operator that has no inverse', async () => {
    await expect(runQuery("SELECT ID FROM EMP WHERE NAME LIKE ANY (SELECT NAME FROM EMP)"))
      .rejects.toThrow();
  });

  describe('scalar subqueries in HAVING', () => {
    it('compares a group aggregate against an uncorrelated scalar subquery', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT HAVING SUM(SAL) > (SELECT AVG(SAL) FROM EMP)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ DEPT: 10 }, { DEPT: 20 }, { DEPT: null }]));
    });

    it('agrees with the literal the subquery evaluates to', async () => {
      const viaSubquery = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT HAVING SUM(SAL) > (SELECT AVG(SAL) FROM EMP)');
      const viaLiteral = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT HAVING SUM(SAL) > 275');
      expect(sortedRows(viaSubquery)).toEqual(sortedRows(viaLiteral));
    });

    it('excludes every group when the comparison is inverted', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT HAVING SUM(SAL) < (SELECT AVG(SAL) FROM EMP)');
      expect(rows).toEqual([]);
    });

    it('does not treat equality as trivially true', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT HAVING SUM(SAL) = (SELECT SUM(SAL) FROM EMP WHERE DEPT = 10)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ DEPT: 10 }, { DEPT: 20 }]));
    });

    it('compares a grouping key against a scalar subquery', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT HAVING DEPT > (SELECT MIN(DEPT) FROM EMP)');
      expect(rows).toEqual([{ DEPT: 20 }]);
    });

    it('compares a group aggregate against a correlated scalar subquery', async () => {
      const rows = await runQuery(
        'SELECT DEPT, COUNT(*) AS C FROM EMP GROUP BY DEPT HAVING COUNT(*) > (SELECT COUNT(*) FROM EMP E2 WHERE E2.DEPT = EMP.DEPT AND E2.MGR IS NOT NULL)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ DEPT: 10, C: 2 }, { DEPT: null, C: 1 }]));
    });

    it('agrees with the same comparison applied outside the grouping', async () => {
      const inHaving = await runQuery(
        'SELECT DEPT, COUNT(*) AS C FROM EMP GROUP BY DEPT HAVING COUNT(*) > (SELECT COUNT(*) FROM EMP E2 WHERE E2.DEPT = EMP.DEPT AND E2.MGR IS NOT NULL)');
      const outside = await runQuery(
        'SELECT DEPT, C FROM (SELECT DEPT, COUNT(*) AS C FROM EMP GROUP BY DEPT) X WHERE C > (SELECT COUNT(*) FROM EMP E2 WHERE E2.DEPT = X.DEPT AND E2.MGR IS NOT NULL)');
      expect(sortedRows(inHaving)).toEqual(sortedRows(outside));
    });

    it('counts zero for a correlated subquery in HAVING that matches no row', async () => {
      const rows = await runQuery(
        'SELECT DEPT FROM EMP GROUP BY DEPT HAVING (SELECT COUNT(*) FROM DEPT D WHERE D.DEPT = EMP.DEPT) = 0');
      expect(rows).toEqual([{ DEPT: null }]);
    });

    it('keeps EXISTS and IN subqueries in HAVING working', async () => {
      expect(sortedRows(await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT HAVING EXISTS (SELECT 1 FROM DEPT)')))
        .toEqual(sortedRows([{ DEPT: 10 }, { DEPT: 20 }, { DEPT: null }]));
      expect(await runQuery("SELECT DEPT FROM EMP GROUP BY DEPT HAVING DEPT IN (SELECT DEPT FROM DEPT WHERE DNAME = 'sales')"))
        .toEqual([{ DEPT: 10 }]);
    });
  });
  describe('several scalar subqueries in one statement', () => {
    it('gives each scalar subquery in the SELECT list its own value', async () => {
      const rows = await runQuery('SELECT (SELECT MIN(SAL) FROM EMP) AS LO, (SELECT MAX(SAL) FROM EMP) AS HI FROM EMP LIMIT 1');
      expect(rows).toEqual([{ LO: 100, HI: 500 }]);
    });

    it('subtracts one scalar subquery from another', async () => {
      const rows = await runQuery('SELECT (SELECT COUNT(*) FROM EMP) - (SELECT COUNT(SAL) FROM EMP) AS N FROM EMP LIMIT 1');
      expect(rows).toEqual([{ N: 1 }]);
    });

    it('keeps three scalar subqueries distinct', async () => {
      const rows = await runQuery('SELECT (SELECT MIN(SAL) FROM EMP) AS A, (SELECT MAX(SAL) FROM EMP) AS B, (SELECT COUNT(*) FROM EMP) AS C FROM EMP LIMIT 1');
      expect(rows).toEqual([{ A: 100, B: 500, C: 5 }]);
    });

    it('keeps two scalar subqueries distinct inside one arithmetic expression', async () => {
      const rows = await runQuery('SELECT (SELECT MAX(SAL) FROM EMP) - (SELECT MIN(SAL) FROM EMP) AS SPAN FROM EMP LIMIT 1');
      expect(rows).toEqual([{ SPAN: 400 }]);
    });

    it('keeps two scalar subqueries distinct in a WHERE clause', async () => {
      const rows = await runQuery('SELECT ID FROM EMP WHERE SAL > (SELECT MIN(SAL) FROM EMP) AND SAL < (SELECT MAX(SAL) FROM EMP)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 2 }, { ID: 3 }]));
    });

    it('still folds a scalar subquery that appears twice', async () => {
      const rows = await runQuery('SELECT (SELECT COUNT(*) FROM EMP) + (SELECT COUNT(*) FROM EMP) AS N FROM EMP LIMIT 1');
      expect(rows).toEqual([{ N: 10 }]);
    });

    it('keeps scalar subqueries distinct across a derived table boundary', async () => {
      const rows = await runQuery('SELECT MAX(X) AS N FROM (SELECT (SELECT MAX(SAL) FROM EMP) - (SELECT MIN(SAL) FROM EMP) AS X FROM EMP) Y');
      expect(rows).toEqual([{ N: 400 }]);
    });
  });

  describe('row-limited correlated subqueries', () => {
    it('applies LIMIT within each correlation group, not across the whole subquery', async () => {
      const rows = await runQuery('SELECT ID FROM EMP E WHERE E.DEPT IN (SELECT F.DEPT FROM EMP F WHERE F.ID = E.ID LIMIT 1)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }]));
    });

    it('orders within the group before applying LIMIT', async () => {
      const rows = await runQuery(
        'SELECT ID FROM EMP E WHERE E.SAL = (SELECT F.SAL FROM EMP F WHERE F.DEPT = E.DEPT ORDER BY F.SAL ASC LIMIT 1)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 1 }, { ID: 3 }]));
    });

    it('applies OFFSET within each correlation group', async () => {
      const rows = await runQuery(
        'SELECT ID FROM EMP E WHERE E.SAL = (SELECT F.SAL FROM EMP F WHERE F.DEPT = E.DEPT ORDER BY F.SAL ASC LIMIT 1 OFFSET 1)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 2 }]));
    });

    it('yields no group rows for LIMIT 0', async () => {
      const rows = await runQuery('SELECT ID FROM EMP E WHERE E.DEPT IN (SELECT F.DEPT FROM EMP F WHERE F.ID = E.ID LIMIT 0)');
      expect(rows).toEqual([]);
    });

    it('keeps NOT IN consistent with the per-group LIMIT', async () => {
      const rows = await runQuery('SELECT ID FROM EMP E WHERE E.DEPT NOT IN (SELECT F.DEPT FROM EMP F WHERE F.ID = E.ID LIMIT 1)');
      expect(rows).toEqual([]);
    });

    it('resolves a correlated scalar subquery that carries a LIMIT', async () => {
      const rows = await runQuery('SELECT ID FROM EMP E WHERE E.SAL >= (SELECT F.SAL FROM EMP F WHERE F.ID = E.ID LIMIT 1)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 5 }]));
    });

    it('leaves an uncorrelated LIMIT applying to the whole subquery', async () => {
      const rows = await runQuery('SELECT ID FROM EMP E WHERE E.SAL >= (SELECT F.SAL FROM EMP F WHERE F.SAL IS NOT NULL ORDER BY F.SAL DESC LIMIT 1)');
      expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 5 }]));
    });

    it('rejects a row limit correlated by a non-equality predicate', async () => {
      await expect(runQuery(
        'SELECT ID FROM EMP E WHERE E.DEPT IN (SELECT F.DEPT FROM EMP F WHERE F.SAL > E.SAL ORDER BY F.ID LIMIT 2)'))
        .rejects.toThrow(/cannot be decorrelated/);
    });
  });

  describe('depth of correlation', () => {
    it('correlates a subquery nested inside another subquery to its own parent', async () => {
      const rows = await runQuery(
        'SELECT ID FROM EMP WHERE EXISTS (SELECT 1 FROM DEPT D WHERE D.DEPT = EMP.DEPT AND EXISTS (SELECT 1 FROM EMP E2 WHERE E2.DEPT = D.DEPT))');
      expect(sortedRows(rows)).toEqual(sortedRows([{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }]));
    });

    it('rejects a correlated reference that reaches past its immediate parent', async () => {
      await expect(runQuery(
        'SELECT ID FROM EMP WHERE EXISTS (SELECT 1 FROM DEPT D WHERE D.DEPT = EMP.DEPT AND EXISTS (SELECT 1 FROM EMP E2 WHERE E2.SAL > EMP.SAL))'))
        .rejects.toThrow(/one level of correlation/);
    });
  });
});
