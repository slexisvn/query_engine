import { describe, it, expect } from 'vitest';
import { runQuery } from '../helpers/sql-oracle.js';

describe('ORDER BY semantics', () => {
  describe('null placement', () => {
    it('honours NULLS FIRST', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY DEPT NULLS FIRST');
      expect(rows).toEqual([{ ID: 5 }, { ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }]);
    });

    it('honours NULLS LAST', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY DEPT NULLS LAST');
      expect(rows).toEqual([{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }, { ID: 5 }]);
    });

    it('defaults ASC to nulls last', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY DEPT');
      expect(rows).toEqual([{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }, { ID: 5 }]);
    });

    it('defaults DESC to nulls first', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY DEPT DESC');
      expect(rows).toEqual([{ ID: 5 }, { ID: 3 }, { ID: 4 }, { ID: 1 }, { ID: 2 }]);
    });

    it('honours NULLS LAST on a descending key', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY DEPT DESC NULLS LAST');
      expect(rows).toEqual([{ ID: 3 }, { ID: 4 }, { ID: 1 }, { ID: 2 }, { ID: 5 }]);
    });

    it('applies null placement per key', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY DEPT NULLS FIRST, SAL DESC NULLS LAST');
      expect(rows).toEqual([{ ID: 5 }, { ID: 2 }, { ID: 1 }, { ID: 3 }, { ID: 4 }]);
    });

    it('applies null placement under a LIMIT', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY DEPT NULLS FIRST LIMIT 2');
      expect(rows).toEqual([{ ID: 5 }, { ID: 1 }]);
    });
  });

  describe('ordinal references', () => {
    it('sorts by the first select item', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY 1 DESC');
      expect(rows).toEqual([{ ID: 5 }, { ID: 4 }, { ID: 3 }, { ID: 2 }, { ID: 1 }]);
    });

    it('sorts by a later select item', async () => {
      const rows = await runQuery('SELECT NAME, DEPT FROM EMP ORDER BY 2 NULLS FIRST, 1');
      expect(rows.map(row => row.NAME)).toEqual(['eve', 'alice', 'bob', 'carol', 'dave']);
    });

    it('rejects an out-of-range position', async () => {
      await expect(runQuery('SELECT ID FROM EMP ORDER BY 3')).rejects.toThrow(/position 3/);
    });

    it('rejects position zero', async () => {
      await expect(runQuery('SELECT ID FROM EMP ORDER BY 0')).rejects.toThrow(/position 0/);
    });
  });

  describe('window functions as sort keys', () => {
    it('sorts by a window function that is not selected', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY ROW_NUMBER() OVER (ORDER BY ID) DESC');
      expect(rows).toEqual([{ ID: 5 }, { ID: 4 }, { ID: 3 }, { ID: 2 }, { ID: 1 }]);
    });

    it('sorts by a window function selected under an alias', async () => {
      const rows = await runQuery('SELECT ID, ROW_NUMBER() OVER (ORDER BY SAL NULLS LAST) AS R FROM EMP ORDER BY R DESC');
      expect(rows.map(row => row.ID)).toEqual([4, 5, 3, 2, 1]);
    });
  });

  describe('sorting still works without changes', () => {
    it('sorts ascending on a non-null column', async () => {
      const rows = await runQuery('SELECT ID FROM EMP ORDER BY NAME');
      expect(rows).toEqual([{ ID: 1 }, { ID: 2 }, { ID: 3 }, { ID: 4 }, { ID: 5 }]);
    });

    it('sorts by an aliased aggregate', async () => {
      const rows = await runQuery('SELECT DEPT, COUNT(*) AS C FROM EMP GROUP BY DEPT ORDER BY C DESC, DEPT NULLS LAST');
      expect(rows).toEqual([
        { DEPT: 10, C: 2 }, { DEPT: 20, C: 2 }, { DEPT: null, C: 1 },
      ]);
    });
  });

  describe('aggregates as sort keys', () => {
    it('sorts by an aggregate that is not in the select list', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT ORDER BY COUNT(*) ASC, DEPT NULLS LAST');
      expect(rows).toEqual([{ DEPT: null }, { DEPT: 10 }, { DEPT: 20 }]);
    });

    it('reverses when the unselected aggregate sort key is descending', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT ORDER BY COUNT(*) DESC, DEPT NULLS LAST');
      expect(rows).toEqual([{ DEPT: 10 }, { DEPT: 20 }, { DEPT: null }]);
    });

    it('sorts by an unselected SUM', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT ORDER BY SUM(SAL) DESC, DEPT NULLS LAST');
      expect(rows).toEqual([{ DEPT: null }, { DEPT: 10 }, { DEPT: 20 }]);
    });

    it('agrees with the same aggregate projected under an alias', async () => {
      const unselected = await runQuery('SELECT DEPT FROM EMP GROUP BY DEPT ORDER BY COUNT(*) ASC, DEPT NULLS LAST');
      const selected = await runQuery('SELECT DEPT, COUNT(*) AS C FROM EMP GROUP BY DEPT ORDER BY C ASC, DEPT NULLS LAST');
      expect(unselected.map(row => row.DEPT)).toEqual(selected.map(row => row.DEPT));
    });
  });
  describe('sort keys over SELECT DISTINCT', () => {
    it('sorts by an aliased distinct output', async () => {
      const rows = await runQuery('SELECT DISTINCT SAL AS S FROM EMP ORDER BY S');
      expect(rows).toEqual([{ S: 100 }, { S: 200 }, { S: 300 }, { S: 500 }, { S: null }]);
    });

    it('sorts descending by an aliased distinct output', async () => {
      const rows = await runQuery('SELECT DISTINCT DEPT AS D FROM EMP ORDER BY D DESC');
      expect(rows).toEqual([{ D: null }, { D: 20 }, { D: 10 }]);
    });

    it('sorts by an unaliased distinct output', async () => {
      const rows = await runQuery('SELECT DISTINCT SAL FROM EMP ORDER BY SAL');
      expect(rows).toEqual([{ SAL: 100 }, { SAL: 200 }, { SAL: 300 }, { SAL: 500 }, { SAL: null }]);
    });

    it('sorts by a computed distinct output referenced by alias', async () => {
      const rows = await runQuery('SELECT DISTINCT SAL + 1 AS S FROM EMP ORDER BY S');
      expect(rows).toEqual([{ S: 101 }, { S: 201 }, { S: 301 }, { S: 501 }, { S: null }]);
    });

    it('sorts by a computed distinct output repeated in the ORDER BY', async () => {
      const rows = await runQuery('SELECT DISTINCT SAL + 1 FROM EMP ORDER BY SAL + 1 DESC');
      expect(rows.map(row => Object.values(row)[0])).toEqual([null, 501, 301, 201, 101]);
    });

    it('sorts by an ordinal over a distinct output', async () => {
      const rows = await runQuery('SELECT DISTINCT SAL AS S FROM EMP ORDER BY 1');
      expect(rows).toEqual([{ S: 100 }, { S: 200 }, { S: 300 }, { S: 500 }, { S: null }]);
    });

    it('sorts by several distinct outputs', async () => {
      const rows = await runQuery('SELECT DISTINCT DEPT AS D, SAL AS S FROM EMP ORDER BY D ASC, S DESC');
      expect(rows).toEqual([
        { D: 10, S: 200 }, { D: 10, S: 100 }, { D: 20, S: null }, { D: 20, S: 300 }, { D: null, S: 500 },
      ]);
    });

    it('applies a LIMIT to the sorted distinct output', async () => {
      const rows = await runQuery('SELECT DISTINCT DEPT AS D FROM EMP ORDER BY D DESC LIMIT 2');
      expect(rows).toEqual([{ D: null }, { D: 20 }]);
    });

    it('rejects a sort key that is not in the distinct output', async () => {
      await expect(runQuery('SELECT DISTINCT DEPT FROM EMP ORDER BY SAL'))
        .rejects.toThrow(/must appear in the SELECT DISTINCT list/);
    });
  });
});
