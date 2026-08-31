import { describe, it, expect } from 'vitest';
import { runQuery } from '../helpers/sql-oracle.js';

describe('text literals adopt the type they are compared against', () => {
  it('matches an integer column against a quoted number', async () => {
    expect(await runQuery("SELECT ID FROM EMP WHERE SAL = '300'")).toEqual([{ ID: 3 }]);
  });

  it('orders an integer column against a quoted number', async () => {
    const rows = await runQuery("SELECT ID FROM EMP WHERE SAL > '250' ORDER BY ID");
    expect(rows).toEqual([{ ID: 3 }, { ID: 5 }]);
  });

  it('matches a date column against a quoted date', async () => {
    expect(await runQuery("SELECT COUNT(*) AS C FROM DT WHERE D = '2020-01-01'")).toEqual([{ C: 1 }]);
  });

  it('coerces every member of an IN list', async () => {
    expect(await runQuery("SELECT COUNT(*) AS C FROM EMP WHERE DEPT IN ('10', '20')")).toEqual([{ C: 4 }]);
  });

  it('coerces both BETWEEN bounds', async () => {
    const rows = await runQuery("SELECT ID FROM EMP WHERE SAL BETWEEN '100' AND '250' ORDER BY ID");
    expect(rows).toEqual([{ ID: 1 }, { ID: 2 }]);
  });

  it('coerces a quoted operand in arithmetic', async () => {
    expect(await runQuery("SELECT SAL + '1' AS X FROM EMP WHERE ID = 1")).toEqual([{ X: 101 }]);
  });

  it('leaves text-to-text comparisons alone', async () => {
    expect(await runQuery("SELECT ID FROM EMP WHERE NAME = 'alice'")).toEqual([{ ID: 1 }]);
  });
});

describe('type mismatches are reported instead of silently missing', () => {
  it('rejects a literal that is not readable as the column type', async () => {
    await expect(runQuery("SELECT ID FROM EMP WHERE SAL = 'abc'"))
      .rejects.toThrow(/Cannot interpret 'abc' as INT32/);
  });

  it('rejects comparing a text column with a numeric column', async () => {
    await expect(runQuery('SELECT ID FROM EMP WHERE NAME = SAL'))
      .rejects.toThrow(/not defined for VARCHAR and INT/);
  });

  it('still allows a date shifted by a whole number of days', async () => {
    const rows = await runQuery('SELECT D + 1 AS X FROM DT ORDER BY D');
    expect(rows).toEqual([{ X: 18263 }, { X: 18293 }]);
  });
});
