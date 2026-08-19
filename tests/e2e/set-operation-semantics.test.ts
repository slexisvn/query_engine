import { describe, it, expect } from 'vitest';
import { runQuery, sortedRows } from '../helpers/sql-oracle.js';

describe('set operation semantics', () => {
  describe('EXCEPT', () => {
    it('removes every left row whose value appears on the right', async () => {
      const rows = await runQuery('SELECT DEPT FROM DEPT EXCEPT SELECT DEPT FROM EMP');
      expect(rows).toEqual([{ DEPT: 30 }]);
    });

    it('produces nothing when both sides are identical', async () => {
      const rows = await runQuery('SELECT K AS X FROM T EXCEPT SELECT K AS X FROM T');
      expect(rows).toEqual([]);
    });

    it('treats null as a value on both sides', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP EXCEPT SELECT DEPT FROM DEPT');
      expect(rows).toEqual([{ DEPT: null }]);
    });

    it('subtracts multiplicities for EXCEPT ALL', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP EXCEPT ALL SELECT DEPT FROM DEPT');
      expect(sortedRows(rows)).toEqual(sortedRows([
        { DEPT: 10 }, { DEPT: 20 }, { DEPT: null },
      ]));
    });

    it('clamps EXCEPT ALL multiplicities at zero', async () => {
      const rows = await runQuery('SELECT DEPT FROM DEPT EXCEPT ALL SELECT DEPT FROM EMP');
      expect(rows).toEqual([{ DEPT: 30 }]);
    });

    it('emits each surviving value once for EXCEPT DISTINCT', async () => {
      const rows = await runQuery('SELECT K AS X FROM T EXCEPT SELECT K AS X FROM T WHERE K = \'a\'');
      expect(sortedRows(rows)).toEqual(sortedRows([{ X: 'b' }, { X: 'c' }, { X: null }]));
    });
  });

  describe('INTERSECT', () => {
    it('keeps only values present on both sides', async () => {
      const rows = await runQuery('SELECT DEPT FROM DEPT INTERSECT SELECT DEPT FROM EMP');
      expect(sortedRows(rows)).toEqual(sortedRows([{ DEPT: 10 }, { DEPT: 20 }]));
    });

    it('emits duplicates up to the smaller multiplicity for INTERSECT ALL', async () => {
      const rows = await runQuery('SELECT DEPT FROM EMP INTERSECT ALL SELECT DEPT FROM DEPT');
      expect(sortedRows(rows)).toEqual(sortedRows([{ DEPT: 10 }, { DEPT: 20 }]));
    });

    it('deduplicates for INTERSECT DISTINCT even when the left side repeats', async () => {
      const rows = await runQuery('SELECT K AS X FROM T INTERSECT SELECT K AS X FROM T');
      expect(sortedRows(rows)).toEqual(sortedRows([
        { X: 'a' }, { X: 'b' }, { X: 'c' }, { X: null },
      ]));
    });

    it('produces nothing when the sides are disjoint', async () => {
      const rows = await runQuery("SELECT K AS X FROM T INTERSECT SELECT K AS X FROM T WHERE K = 'zzz'");
      expect(rows).toEqual([]);
    });
  });

  describe('UNION is unaffected', () => {
    it('deduplicates across both sides', async () => {
      const rows = await runQuery('SELECT DEPT FROM DEPT UNION SELECT DEPT FROM EMP');
      expect(sortedRows(rows)).toEqual(sortedRows([
        { DEPT: 10 }, { DEPT: 20 }, { DEPT: 30 }, { DEPT: null },
      ]));
    });

    it('keeps every row for UNION ALL', async () => {
      const rows = await runQuery('SELECT DEPT FROM DEPT UNION ALL SELECT DEPT FROM EMP');
      expect(rows).toHaveLength(8);
    });
  });

  describe('trailing clauses apply to the whole set operation', () => {
    it('orders the combined result rather than the last branch', async () => {
      const rows = await runQuery('SELECT DEPT AS X FROM EMP UNION SELECT DEPT AS X FROM DEPT ORDER BY X');
      expect(rows).toEqual([{ X: 10 }, { X: 20 }, { X: 30 }, { X: null }]);
    });

    it('orders descending with nulls first by default', async () => {
      const rows = await runQuery('SELECT DEPT AS X FROM EMP UNION SELECT DEPT AS X FROM DEPT ORDER BY X DESC');
      expect(rows).toEqual([{ X: null }, { X: 30 }, { X: 20 }, { X: 10 }]);
    });

    it('orders a multi-column set operation by output column name', async () => {
      const rows = await runQuery(
        'SELECT DEPT AS X, DNAME AS N FROM DEPT UNION ALL SELECT DEPT AS X, NAME AS N FROM EMP ORDER BY N');
      expect(rows.map(row => row.N)).toEqual(['alice', 'bob', 'carol', 'dave', 'eng', 'eve', 'hr', 'sales']);
    });

    it('orders by ordinal position', async () => {
      const rows = await runQuery('SELECT DEPT AS X FROM DEPT UNION ALL SELECT DEPT AS X FROM EMP ORDER BY 1 LIMIT 3');
      expect(rows).toEqual([{ X: 10 }, { X: 10 }, { X: 10 }]);
    });

    it('limits the combined result', async () => {
      const rows = await runQuery('SELECT DEPT AS X FROM DEPT UNION ALL SELECT DEPT AS X FROM EMP LIMIT 2');
      expect(rows).toHaveLength(2);
    });

    it('rejects an ORDER BY key that is not an output column', async () => {
      await expect(runQuery('SELECT DEPT AS X FROM DEPT UNION SELECT DEPT AS X FROM EMP ORDER BY DNAME'))
        .rejects.toThrow(/set operation/);
    });
  });
});
