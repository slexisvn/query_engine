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
});
