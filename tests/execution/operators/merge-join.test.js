import { describe, it, expect } from 'vitest';
import { MergeJoinOperator } from '../../../src/execution/operators/merge-join.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { JoinType } from '../../../src/planner/logical-plan.js';

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function keyAt(colIdx) {
  return (chunk, row) => chunk.columns[colIdx].get(row);
}

async function merge(buildDef, probeDef, joinType, opts = {}) {
  const buildChunks = [makeChunk(buildDef)];
  const probeChunks = [makeChunk(probeDef)];
  const op = new MergeJoinOperator(
    buildChunks,
    probeChunks,
    [keyAt(0)],
    [keyAt(0)],
    buildDef.length,
    probeDef.length,
    joinType,
    opts.condition || null
  );
  const result = await op.execute();
  return result.flatMap(c => c.toRows());
}

describe('MergeJoinOperator', () => {
  describe('INNER JOIN', () => {
    it('joins sorted inputs on matching keys', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['a', 'b', 'c'] }],
        [{ type: 'INT32', values: [2, 3, 4] }, { type: 'VARCHAR', values: ['x', 'y', 'z'] }],
        JoinType.INNER
      );

      expect(rows.length).toBe(2);
      expect(rows[0][0]).toBe(2);
      expect(rows[0][2]).toBe(2);
      expect(rows[0][3]).toBe('x');
    });

    it('returns empty when no keys match', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 2] }],
        [{ type: 'INT32', values: [3, 4] }],
        JoinType.INNER
      );

      expect(rows.length).toBe(0);
    });

    it('handles duplicate keys with cross product', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 1] }, { type: 'VARCHAR', values: ['a', 'b'] }],
        [{ type: 'INT32', values: [1, 1] }, { type: 'VARCHAR', values: ['x', 'y'] }],
        JoinType.INNER
      );

      expect(rows.length).toBe(4);
    });
  });

  describe('LEFT JOIN', () => {
    it('keeps unmatched build rows with null probe columns', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['a', 'b', 'c'] }],
        [{ type: 'INT32', values: [2] }, { type: 'VARCHAR', values: ['x'] }],
        JoinType.LEFT
      );

      expect(rows.length).toBe(3);
      const row1 = rows.find(r => r[0] === 1);
      expect(row1[2]).toBeNull();
      expect(row1[3]).toBeNull();
      const row3 = rows.find(r => r[0] === 3);
      expect(row3[2]).toBeNull();
    });
  });

  describe('RIGHT JOIN', () => {
    it('keeps unmatched probe rows with null build columns', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [2] }, { type: 'VARCHAR', values: ['a'] }],
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['x', 'y', 'z'] }],
        JoinType.RIGHT
      );

      expect(rows.length).toBe(3);
      const row1 = rows.find(r => r[2] === 1);
      expect(row1[0]).toBeNull();
      const row3 = rows.find(r => r[2] === 3);
      expect(row3[0]).toBeNull();
    });
  });

  describe('FULL JOIN', () => {
    it('keeps unmatched rows from both sides', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 3] }, { type: 'VARCHAR', values: ['a', 'c'] }],
        [{ type: 'INT32', values: [2, 3] }, { type: 'VARCHAR', values: ['x', 'y'] }],
        JoinType.FULL
      );

      expect(rows.length).toBe(3);
      const row1 = rows.find(r => r[0] === 1);
      expect(row1[2]).toBeNull();
      const row2 = rows.find(r => r[2] === 2);
      expect(row2[0]).toBeNull();
      const row3 = rows.find(r => r[0] === 3 && r[2] === 3);
      expect(row3).toBeDefined();
    });

    it('handles completely disjoint sets', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 2] }],
        [{ type: 'INT32', values: [3, 4] }],
        JoinType.FULL
      );

      expect(rows.length).toBe(4);
    });
  });

  describe('condition evaluator', () => {
    it('filters matched rows with residual predicate', async () => {
      const condition = (adapter, _) => adapter.row[1] < adapter.row[3];
      const rows = await merge(
        [{ type: 'INT32', values: [1, 1] }, { type: 'INT32', values: [10, 20] }],
        [{ type: 'INT32', values: [1] }, { type: 'INT32', values: [15] }],
        JoinType.INNER,
        { condition }
      );

      expect(rows.length).toBe(1);
      expect(rows[0][1]).toBe(10);
    });

    it('emits null row for LEFT join when condition rejects all matches', async () => {
      const condition = (adapter, _) => false;
      const rows = await merge(
        [{ type: 'INT32', values: [1] }, { type: 'INT32', values: [10] }],
        [{ type: 'INT32', values: [1] }, { type: 'INT32', values: [20] }],
        JoinType.LEFT,
        { condition }
      );

      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe(1);
      expect(rows[0][2]).toBeNull();
    });
  });

  describe('empty inputs', () => {
    it('returns empty for empty build side', async () => {
      const buildChunks = [makeChunk([{ type: 'INT32', values: [] }])];
      const probeChunks = [makeChunk([{ type: 'INT32', values: [1, 2] }])];
      const op = new MergeJoinOperator(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], 1, 1, JoinType.INNER);

      const result = await op.execute();

      expect(result.length).toBe(0);
    });

    it('returns empty for empty probe side on INNER', async () => {
      const buildChunks = [makeChunk([{ type: 'INT32', values: [1, 2] }])];
      const probeChunks = [makeChunk([{ type: 'INT32', values: [] }])];
      const op = new MergeJoinOperator(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], 1, 1, JoinType.INNER);

      const result = await op.execute();

      expect(result.length).toBe(0);
    });
  });

  describe('multi-key join', () => {
    it('joins on composite keys', async () => {
      const buildChunks = [makeChunk([
        { type: 'INT32', values: [1, 1, 2] },
        { type: 'VARCHAR', values: ['a', 'b', 'a'] },
      ])];
      const probeChunks = [makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'VARCHAR', values: ['a', 'b'] },
      ])];
      const op = new MergeJoinOperator(
        buildChunks,
        probeChunks,
        [keyAt(0), keyAt(1)],
        [keyAt(0), keyAt(1)],
        2, 2,
        JoinType.INNER
      );

      const result = await op.execute();
      const rows = result.flatMap(c => c.toRows());

      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe(1);
      expect(rows[0][1]).toBe('a');
    });
  });

  describe('preserves data types', () => {
    it('output columns have correct data types from input', async () => {
      const buildChunks = [makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'FLOAT64', values: [3.14] },
      ])];
      const probeChunks = [makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'VARCHAR', values: ['hello'] },
      ])];
      const op = new MergeJoinOperator(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], 2, 2, JoinType.INNER);

      const result = await op.execute();

      expect(result[0].columns[0].dataType).toBe('INT32');
      expect(result[0].columns[1].dataType).toBe('FLOAT64');
      expect(result[0].columns[2].dataType).toBe('INT32');
      expect(result[0].columns[3].dataType).toBe('VARCHAR');
    });
  });
});
