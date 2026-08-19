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
});
