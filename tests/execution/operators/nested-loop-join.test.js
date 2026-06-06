import { describe, it, expect } from 'vitest';
import { NestedLoopJoinOperator } from '../../../src/execution/operators/nested-loop-join.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { JoinType } from '../../../src/planner/logical-plan.js';

function makeChunk(rows, types) {
  if (rows.length === 0) return new DataChunk([], 0);
  const colCount = rows[0].length;
  const columns = [];
  for (let c = 0; c < colCount; c++) {
    const col = new Column(types?.[c] || 'INT32', rows.length);
    for (let r = 0; r < rows.length; r++) {
      col.set(r, rows[r][c]);
    }
    col.length = rows.length;
    columns.push(col);
  }
  return new DataChunk(columns, rows.length);
}

function extractRows(chunks) {
  const rows = [];
  for (const chunk of chunks) {
    for (let r = 0; r < chunk.size; r++) {
      const row = [];
      for (let c = 0; c < chunk.columns.length; c++) {
        row.push(chunk.columns[c].get(r));
      }
      rows.push(row);
    }
  }
  return rows;
}

describe('NestedLoopJoinOperator', () => {
  describe('INNER join', () => {
    it('produces correct cross-product rows for matching condition', async () => {
      const outer = [makeChunk([[1, 'a'], [2, 'b'], [3, 'c']], ['INT32', 'VARCHAR'])];
      const inner = [makeChunk([[1, 'x'], [2, 'y'], [3, 'z']], ['INT32', 'VARCHAR'])];

      const condFn = (adapter, _) => {
        return adapter.columns[0].get() === adapter.columns[2].get();
      };

      const op = new NestedLoopJoinOperator(outer, inner, 2, 2, JoinType.INNER, condFn);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual([1, 'a', 1, 'x']);
      expect(rows[1]).toEqual([2, 'b', 2, 'y']);
      expect(rows[2]).toEqual([3, 'c', 3, 'z']);
    });

    it('returns empty when no rows match', async () => {
      const outer = [makeChunk([[1], [2]])];
      const inner = [makeChunk([[10], [20]])];

      const condFn = (adapter, _) => adapter.columns[0].get() === adapter.columns[1].get();

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.INNER, condFn);
      const result = await op.execute();

      expect(result).toHaveLength(0);
    });

    it('produces full cross join without condition evaluator', async () => {
      const outer = [makeChunk([[1], [2]])];
      const inner = [makeChunk([[10], [20], [30]])];

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.INNER, null);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(6);
      expect(rows).toContainEqual([1, 10]);
      expect(rows).toContainEqual([1, 20]);
      expect(rows).toContainEqual([1, 30]);
      expect(rows).toContainEqual([2, 10]);
      expect(rows).toContainEqual([2, 20]);
      expect(rows).toContainEqual([2, 30]);
    });

    it('handles one-to-many matches correctly', async () => {
      const outer = [makeChunk([[1]])];
      const inner = [makeChunk([[1, 'a'], [1, 'b'], [2, 'c']], ['INT32', 'VARCHAR'])];

      const condFn = (adapter, _) => adapter.columns[0].get() === adapter.columns[1].get();

      const op = new NestedLoopJoinOperator(outer, inner, 1, 2, JoinType.INNER, condFn);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual([1, 1, 'a']);
      expect(rows[1]).toEqual([1, 1, 'b']);
    });
  });

  describe('LEFT join', () => {
    it('preserves unmatched outer rows with nulls', async () => {
      const outer = [makeChunk([[1], [2], [3]])];
      const inner = [makeChunk([[1, 'x']], ['INT32', 'VARCHAR'])];

      const condFn = (adapter, _) => adapter.columns[0].get() === adapter.columns[1].get();

      const op = new NestedLoopJoinOperator(outer, inner, 1, 2, JoinType.LEFT, condFn);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual([1, 1, 'x']);
      expect(rows[1]).toEqual([2, null, null]);
      expect(rows[2]).toEqual([3, null, null]);
    });

    it('emits all matches for outer row plus unmatched', async () => {
      const outer = [makeChunk([[1], [2]])];
      const inner = [makeChunk([[1, 'a'], [1, 'b']], ['INT32', 'VARCHAR'])];

      const condFn = (adapter, _) => adapter.columns[0].get() === adapter.columns[1].get();

      const op = new NestedLoopJoinOperator(outer, inner, 1, 2, JoinType.LEFT, condFn);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual([1, 1, 'a']);
      expect(rows[1]).toEqual([1, 1, 'b']);
      expect(rows[2]).toEqual([2, null, null]);
    });
  });

  describe('SEMI join', () => {
    it('emits outer row once when any inner matches', async () => {
      const outer = [makeChunk([[1, 'a'], [2, 'b'], [3, 'c']], ['INT32', 'VARCHAR'])];
      const inner = [makeChunk([[1], [1], [3]])];

      const condFn = (adapter, _) => adapter.columns[0].get() === adapter.columns[2].get();

      const op = new NestedLoopJoinOperator(outer, inner, 2, 1, JoinType.SEMI, condFn);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual([1, 'a']);
      expect(rows[1]).toEqual([3, 'c']);
    });

    it('does not duplicate outer row on multiple inner matches', async () => {
      const outer = [makeChunk([[1]])];
      const inner = [makeChunk([[1], [1], [1]])];

      const condFn = (adapter, _) => adapter.columns[0].get() === adapter.columns[1].get();

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.SEMI, condFn);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual([1]);
    });
  });

  describe('ANTI join', () => {
    it('emits outer rows with no inner match', async () => {
      const outer = [makeChunk([[1], [2], [3]])];
      const inner = [makeChunk([[1], [3]])];

      const condFn = (adapter, _) => adapter.columns[0].get() === adapter.columns[1].get();

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.ANTI, condFn);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual([2]);
    });

    it('returns all outer rows when inner is empty', async () => {
      const outer = [makeChunk([[1], [2]])];
      const inner = [];

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.ANTI, null);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(2);
    });
  });

  describe('MARK join', () => {
    it('appends true/false mark column based on match', async () => {
      const outer = [makeChunk([[1], [2], [3]])];
      const inner = [makeChunk([[1], [3]])];

      const condFn = (adapter, _) => adapter.columns[0].get() === adapter.columns[1].get();

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.MARK, condFn);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual([1, true]);
      expect(rows[1]).toEqual([2, false]);
      expect(rows[2]).toEqual([3, true]);
    });
  });

  describe('edge cases', () => {
    it('handles empty outer', async () => {
      const outer = [];
      const inner = [makeChunk([[1], [2]])];

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.INNER, null);
      const result = await op.execute();

      expect(result).toHaveLength(0);
    });

    it('handles empty inner with INNER join', async () => {
      const outer = [makeChunk([[1], [2]])];
      const inner = [];

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.INNER, null);
      const result = await op.execute();

      expect(result).toHaveLength(0);
    });

    it('handles multiple chunks on both sides', async () => {
      const outer = [makeChunk([[1]]), makeChunk([[2]])];
      const inner = [makeChunk([[10]]), makeChunk([[20]])];

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.INNER, null);
      const result = await op.execute();
      const rows = extractRows(result);

      expect(rows).toHaveLength(4);
      expect(rows).toContainEqual([1, 10]);
      expect(rows).toContainEqual([1, 20]);
      expect(rows).toContainEqual([2, 10]);
      expect(rows).toContainEqual([2, 20]);
    });

    it('preserves data types from source chunks', async () => {
      const outer = [makeChunk([['hello']], ['VARCHAR'])];
      const inner = [makeChunk([[42]], ['INT32'])];

      const op = new NestedLoopJoinOperator(outer, inner, 1, 1, JoinType.INNER, null);
      const result = await op.execute();

      expect(result[0].columns[0].dataType).toBe('VARCHAR');
      expect(result[0].columns[1].dataType).toBe('INT32');
    });
  });
});
