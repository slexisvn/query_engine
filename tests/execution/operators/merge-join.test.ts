import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MergeJoinOperator, mergeJoinSortKeys } from '../../../src/execution/operators/merge-join.js';
import { SortOperator } from '../../../src/execution/operators/sort.js';
import { SpillManager } from '../../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';
import { DataType } from '../../../src/storage/data-type.js';
import { captureMemoryLimit, limitResidentRows } from '../../helpers/memory-limits.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { JoinType } from '../../../src/planner/logical-plan.js';
import { Config } from '../../../src/config.js';

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

function typesOf(chunks) {
  return chunks[0].columns.map(c => c.dataType);
}

function sortedSource(chunks, extractors) {
  return async function* () {
    const sortOp = new SortOperator(mergeJoinSortKeys(extractors), null, 0, new SpillManager(new MemoryStorage()));
    for (const chunk of chunks) await sortOp.consume(chunk);
    yield* sortOp.stream();
  };
}

function rawSource(chunks) {
  return async function* () {
    for (const chunk of chunks) yield chunk;
  };
}

function mergeOp(buildChunks, probeChunks, buildKeys, probeKeys, joinType, condition = null) {
  return new MergeJoinOperator(
    sortedSource(buildChunks, buildKeys),
    sortedSource(probeChunks, probeKeys),
    buildKeys,
    probeKeys,
    typesOf(buildChunks),
    typesOf(probeChunks),
    joinType,
    condition,
  );
}

async function collect(op) {
  const chunks = [];
  for await (const chunk of op.execute()) chunks.push(chunk);
  return chunks;
}

async function merge(buildDef, probeDef, joinType, opts = {}) {
  const op = mergeOp(
    [makeChunk(buildDef)],
    [makeChunk(probeDef)],
    [keyAt(0)],
    [keyAt(0)],
    joinType,
    opts.condition || null,
  );
  return (await collect(op)).flatMap(c => c.toRows());
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

  describe('NULL keys never match (SQL semantics)', () => {
    it('INNER: null keys do not match null or any value', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, null] }, { type: 'VARCHAR', values: ['a', 'n'] }],
        [{ type: 'INT32', values: [1, null] }, { type: 'VARCHAR', values: ['x', 'm'] }],
        JoinType.INNER
      );
      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe(1);
      expect(rows[0][3]).toBe('x');
    });

    it('LEFT: null-keyed build row is emitted unmatched', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, null] }, { type: 'VARCHAR', values: ['a', 'n'] }],
        [{ type: 'INT32', values: [1] }, { type: 'VARCHAR', values: ['x'] }],
        JoinType.LEFT
      );
      expect(rows.length).toBe(2);
      const nullRow = rows.find(r => r[0] === null);
      expect(nullRow[1]).toBe('n');
      expect(nullRow[3]).toBe(null);
    });

    it('RIGHT: null-keyed row of the preserved side is emitted unmatched', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, null] }, { type: 'VARCHAR', values: ['x', 'm'] }],
        [{ type: 'INT32', values: [1] }, { type: 'VARCHAR', values: ['a'] }],
        JoinType.RIGHT
      );
      expect(rows.length).toBe(2);
      const nullRow = rows.find(r => r[0] === null);
      expect(nullRow[1]).toBe('m');
      expect(nullRow[2]).toBe(null);
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
    it('keeps every row of the preserved side, padding the other with nulls', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['x', 'y', 'z'] }],
        [{ type: 'INT32', values: [2] }, { type: 'VARCHAR', values: ['a'] }],
        JoinType.RIGHT
      );

      expect(rows.length).toBe(3);
      const row1 = rows.find(r => r[0] === 1);
      expect(row1[2]).toBeNull();
      const row3 = rows.find(r => r[0] === 3);
      expect(row3[2]).toBeNull();
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

    it('re-evaluates the residual for every pair when both sides have duplicate keys', async () => {
      const condition = (adapter, _) => adapter.row[1] < adapter.row[3];
      const rows = await merge(
        [{ type: 'INT32', values: [1, 1, 1] }, { type: 'INT32', values: [10, 20, 30] }],
        [{ type: 'INT32', values: [1, 1] }, { type: 'INT32', values: [15, 25] }],
        JoinType.INNER,
        { condition }
      );

      expect(rows).toEqual([[1, 10, 1, 15], [1, 10, 1, 25], [1, 20, 1, 25]]);
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
      const op = mergeOp(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], JoinType.INNER);

      const result = await collect(op);

      expect(result.length).toBe(0);
    });

    it('returns empty for empty probe side on INNER', async () => {
      const buildChunks = [makeChunk([{ type: 'INT32', values: [1, 2] }])];
      const probeChunks = [makeChunk([{ type: 'INT32', values: [] }])];
      const op = mergeOp(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], JoinType.INNER);

      const result = await collect(op);

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
      const op = mergeOp(buildChunks, probeChunks, [keyAt(0), keyAt(1)], [keyAt(0), keyAt(1)], JoinType.INNER);

      const result = await collect(op);
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
      const op = mergeOp(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], JoinType.INNER);

      const result = await collect(op);

      expect(result[0].columns[0].dataType).toBe('INT32');
      expect(result[0].columns[1].dataType).toBe('FLOAT64');
      expect(result[0].columns[2].dataType).toBe('INT32');
      expect(result[0].columns[3].dataType).toBe('VARCHAR');
    });
  });

  describe('SEMI JOIN', () => {
    it('outputs only probe rows that have at least one matching build row', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 3] }, { type: 'VARCHAR', values: ['dept_a', 'dept_c'] }],
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['alice', 'bob', 'charlie'] }],
        JoinType.SEMI
      );

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual([1, 'alice']);
      expect(rows[1]).toEqual([3, 'charlie']);
    });

    it('outputs probe-side columns only, excluding build-side columns', async () => {
      const buildChunks = [makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'VARCHAR', values: ['extra_b1', 'extra_b2'] },
      ])];
      const probeChunks = [makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['p1', 'p2', 'p3'] },
        { type: 'FLOAT64', values: [10.0, 20.0, 30.0] },
      ])];
      const op = mergeOp(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], JoinType.SEMI);

      const result = await collect(op);
      const rows = result.flatMap(c => c.toRows());

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual([1, 'p1', 10.0]);
      expect(rows[1]).toEqual([2, 'p2', 20.0]);
      expect(result[0].columns.length).toBe(3);
    });

    it('deduplicates probe rows when multiple build rows match the same key', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 1, 1] }],
        [{ type: 'INT32', values: [1] }, { type: 'VARCHAR', values: ['only_once'] }],
        JoinType.SEMI
      );

      expect(rows.length).toBe(1);
      expect(rows[0]).toEqual([1, 'only_once']);
    });

    it('returns empty when no keys match', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [10, 20] }],
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['a', 'b', 'c'] }],
        JoinType.SEMI
      );

      expect(rows.length).toBe(0);
    });

    it('respects residual condition when filtering matches', async () => {
      const condition = (adapter, _) => adapter.row[1] > 5;
      const rows = await merge(
        [{ type: 'INT32', values: [1, 1] }, { type: 'INT32', values: [3, 10] }],
        [{ type: 'INT32', values: [1] }, { type: 'VARCHAR', values: ['x'] }],
        JoinType.SEMI,
        { condition }
      );

      expect(rows.length).toBe(1);
      expect(rows[0]).toEqual([1, 'x']);
    });

    it('finds a match on the last build row of a duplicate-key group', async () => {
      const condition = (adapter, _) => adapter.row[1] > 25;
      const rows = await merge(
        [{ type: 'INT32', values: [1, 1, 1] }, { type: 'INT32', values: [10, 20, 30] }],
        [{ type: 'INT32', values: [1] }, { type: 'INT32', values: [25] }],
        JoinType.SEMI,
        { condition }
      );

      expect(rows).toEqual([[1, 25]]);
    });

    it('excludes probe rows when residual rejects all matching build rows', async () => {
      const condition = (adapter, _) => false;
      const rows = await merge(
        [{ type: 'INT32', values: [1] }, { type: 'INT32', values: [5] }],
        [{ type: 'INT32', values: [1] }, { type: 'VARCHAR', values: ['x'] }],
        JoinType.SEMI,
        { condition }
      );

      expect(rows.length).toBe(0);
    });
  });

  describe('ANTI JOIN', () => {
    it('outputs only probe rows that have no matching build row', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 3] }],
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['alice', 'bob', 'charlie'] }],
        JoinType.ANTI
      );

      expect(rows.length).toBe(1);
      expect(rows[0]).toEqual([2, 'bob']);
    });

    it('outputs probe-side columns only, excluding build-side columns', async () => {
      const buildChunks = [makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'VARCHAR', values: ['build_col'] },
      ])];
      const probeChunks = [makeChunk([
        { type: 'INT32', values: [2] },
        { type: 'VARCHAR', values: ['probe_val'] },
      ])];
      const op = mergeOp(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], JoinType.ANTI);

      const result = await collect(op);
      const rows = result.flatMap(c => c.toRows());

      expect(rows.length).toBe(1);
      expect(rows[0]).toEqual([2, 'probe_val']);
      expect(result[0].columns.length).toBe(2);
    });

    it('returns all probe rows when build side is empty', async () => {
      const buildChunks = [makeChunk([{ type: 'INT32', values: [] }])];
      const probeChunks = [makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'VARCHAR', values: ['a', 'b'] },
      ])];
      const op = mergeOp(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], JoinType.ANTI);

      const result = await collect(op);
      const rows = result.flatMap(c => c.toRows());

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual([1, 'a']);
      expect(rows[1]).toEqual([2, 'b']);
    });

    it('includes probe row when residual rejects all matching build rows', async () => {
      const condition = (adapter, _) => false;
      const rows = await merge(
        [{ type: 'INT32', values: [1] }, { type: 'INT32', values: [5] }],
        [{ type: 'INT32', values: [1] }, { type: 'VARCHAR', values: ['x'] }],
        JoinType.ANTI,
        { condition }
      );

      expect(rows.length).toBe(1);
      expect(rows[0]).toEqual([1, 'x']);
    });
  });

  describe('MARK JOIN', () => {
    it('appends true mark for matching probe rows and false for non-matching', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 3] }],
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['a', 'b', 'c'] }],
        JoinType.MARK
      );

      expect(rows.length).toBe(3);
      expect(rows[0]).toEqual([1, 'a', true]);
      expect(rows[1]).toEqual([2, 'b', false]);
      expect(rows[2]).toEqual([3, 'c', true]);
    });

    it('marks NULL (not false) for an unmatched probe when the build side has a NULL key (3VL for NOT IN)', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, null] }],
        [{ type: 'INT32', values: [1, 3] }, { type: 'VARCHAR', values: ['m', 'u'] }],
        JoinType.MARK
      );
      const matched = rows.find(r => r[0] === 1);
      const unmatched = rows.find(r => r[0] === 3);
      expect(matched[2]).toBe(true);
      expect(unmatched[2]).toBe(null);
    });

    it('marks NULL for a NULL probe value (3VL)', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1] }],
        [{ type: 'INT32', values: [null] }, { type: 'VARCHAR', values: ['n'] }],
        JoinType.MARK
      );
      expect(rows.length).toBe(1);
      expect(rows[0][2]).toBe(null);
    });

    it('marks false for an unmatched probe when the build side has no NULL key', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1] }],
        [{ type: 'INT32', values: [3] }, { type: 'VARCHAR', values: ['u'] }],
        JoinType.MARK
      );
      expect(rows[0][2]).toBe(false);
    });

    it('output has probeColCount + 1 columns with BOOLEAN mark column', async () => {
      const buildChunks = [makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'VARCHAR', values: ['extra'] },
      ])];
      const probeChunks = [makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'VARCHAR', values: ['val'] },
      ])];
      const op = mergeOp(buildChunks, probeChunks, [keyAt(0)], [keyAt(0)], JoinType.MARK);

      const result = await collect(op);

      expect(result[0].columns.length).toBe(3);
      expect(result[0].columns[2].dataType).toBe('BOOLEAN');
      const rows = result.flatMap(c => c.toRows());
      expect(rows[0]).toEqual([1, 'val', true]);
    });

    it('marks false when residual condition rejects all matching build rows', async () => {
      const condition = (adapter, _) => false;
      const rows = await merge(
        [{ type: 'INT32', values: [1] }, { type: 'INT32', values: [5] }],
        [{ type: 'INT32', values: [1] }, { type: 'VARCHAR', values: ['x'] }],
        JoinType.MARK,
        { condition }
      );

      expect(rows.length).toBe(1);
      expect(rows[0]).toEqual([1, 'x', false]);
    });
  });

  describe('SINGLE JOIN', () => {
    it('keeps every probe row and takes at most one build match', async () => {
      const rows = await merge(
        [{ type: DataType.INT32, values: [1, 1, 3] }, { type: DataType.VARCHAR, values: ['b1', 'b2', 'b3'] }],
        [{ type: DataType.INT32, values: [1, 2] }, { type: DataType.VARCHAR, values: ['p1', 'p2'] }],
        JoinType.SINGLE,
      );
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual([1, 'b1', 1, 'p1']);
      expect(rows).toContainEqual([null, null, 2, 'p2']);
    });

    it('pads a null-keyed probe row', async () => {
      const rows = await merge(
        [{ type: DataType.INT32, values: [1] }, { type: DataType.VARCHAR, values: ['b1'] }],
        [{ type: DataType.INT32, values: [null] }, { type: DataType.VARCHAR, values: ['pn'] }],
        JoinType.SINGLE,
      );
      expect(rows).toEqual([[null, null, null, 'pn']]);
    });
  });

  describe('MARK JOIN with a two-sided residual', () => {
    it('marks each probe row by its own matches within a duplicate-key group', async () => {
      const condition = (adapter, _) => adapter.row[1] < adapter.row[3];
      const rows = await merge(
        [{ type: 'INT32', values: [1, 1] }, { type: 'INT32', values: [10, 20] }],
        [{ type: 'INT32', values: [1, 1] }, { type: 'INT32', values: [5, 25] }],
        JoinType.MARK,
        { condition }
      );

      expect(rows).toEqual([[1, 5, false], [1, 25, true]]);
    });
  });

  describe('MARK JOIN with an unknown residual', () => {
    it('marks unknown rather than false when the residual never resolves', async () => {
      const rows = await merge(
        [{ type: DataType.INT32, values: [1] }],
        [{ type: DataType.INT32, values: [1] }],
        JoinType.MARK,
        { condition: () => null },
      );
      expect(rows).toEqual([[1, null]]);
    });
  });

  describe('unsorted input handling', () => {
    it('sorts unsorted build side before merging', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [3, 1, 2] }, { type: 'VARCHAR', values: ['c', 'a', 'b'] }],
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['x', 'y', 'z'] }],
        JoinType.INNER
      );

      expect(rows.length).toBe(3);
      const matched = rows.map(r => [r[0], r[1], r[3]]);
      expect(matched).toContainEqual([1, 'a', 'x']);
      expect(matched).toContainEqual([2, 'b', 'y']);
      expect(matched).toContainEqual([3, 'c', 'z']);
    });

    it('sorts unsorted probe side before merging', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [1, 2, 3] }, { type: 'VARCHAR', values: ['a', 'b', 'c'] }],
        [{ type: 'INT32', values: [3, 1, 2] }, { type: 'VARCHAR', values: ['z', 'x', 'y'] }],
        JoinType.INNER
      );

      expect(rows.length).toBe(3);
      const matched = rows.map(r => [r[0], r[1], r[3]]);
      expect(matched).toContainEqual([1, 'a', 'x']);
      expect(matched).toContainEqual([2, 'b', 'y']);
      expect(matched).toContainEqual([3, 'c', 'z']);
    });

    it('sorts both sides and produces correct INNER join with non-monotonic keys', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [10, 10, 20, 20, 30, 30, 10, 20] }, { type: 'VARCHAR', values: ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'a3', 'b3'] }],
        [{ type: 'INT32', values: [10, 20] }, { type: 'VARCHAR', values: ['X', 'Y'] }],
        JoinType.INNER
      );

      const key10Rows = rows.filter(r => r[0] === 10);
      const key20Rows = rows.filter(r => r[0] === 20);
      expect(key10Rows.length).toBe(3);
      expect(key20Rows.length).toBe(3);
      expect(rows.length).toBe(6);
    });

    it('LEFT JOIN with unsorted input preserves all build rows', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [3, 1, 5, 2] }, { type: 'VARCHAR', values: ['c', 'a', 'e', 'b'] }],
        [{ type: 'INT32', values: [2, 1] }, { type: 'VARCHAR', values: ['y', 'x'] }],
        JoinType.LEFT
      );

      expect(rows.length).toBe(4);
      const matchedRow = rows.find(r => r[0] === 1);
      expect(matchedRow[3]).toBe('x');
      const unmatchedRow = rows.find(r => r[0] === 5);
      expect(unmatchedRow[2]).toBeNull();
      expect(unmatchedRow[3]).toBeNull();
    });

    it('SEMI JOIN with unsorted input returns correct probe rows', async () => {
      const rows = await merge(
        [{ type: 'INT32', values: [3, 1] }],
        [{ type: 'INT32', values: [3, 2, 1] }, { type: 'VARCHAR', values: ['c', 'b', 'a'] }],
        JoinType.SEMI
      );

      expect(rows.length).toBe(2);
      const names = rows.map(r => r[1]).sort();
      expect(names).toEqual(['a', 'c']);
    });
  });
});

describe('MergeJoinOperator input ordering', () => {
  it('accepts input the sort delivered in key order', async () => {
    const rows = await merge(
      [{ type: 'INT32', values: [9, 1, 5] }],
      [{ type: 'INT32', values: [5, 9, 1] }],
      JoinType.INNER,
    );

    expect(rows.map(r => r[0])).toEqual([1, 5, 9]);
  });

  it('rejects an unsorted stream loudly instead of dropping matches', async () => {
    const buildChunks = [makeChunk([{ type: 'INT32', values: [9, 1, 5] }])];
    const probeChunks = [makeChunk([{ type: 'INT32', values: [1, 5, 9] }])];
    const op = new MergeJoinOperator(
      rawSource(buildChunks),
      rawSource(probeChunks),
      [keyAt(0)],
      [keyAt(0)],
      typesOf(buildChunks),
      typesOf(probeChunks),
      JoinType.INNER,
    );

    await expect(collect(op)).rejects.toThrow(/unsorted build side/);
  });

  it('names the probe side when that is the unsorted one', async () => {
    const buildChunks = [makeChunk([{ type: 'INT32', values: [1, 5, 9] }])];
    const probeChunks = [makeChunk([{ type: 'INT32', values: [9, 1] }])];
    const op = new MergeJoinOperator(
      rawSource(buildChunks),
      rawSource(probeChunks),
      [keyAt(0)],
      [keyAt(0)],
      typesOf(buildChunks),
      typesOf(probeChunks),
      JoinType.INNER,
    );

    await expect(collect(op)).rejects.toThrow(/unsorted probe side/);
  });
});

describe('MergeJoinOperator memory safety', () => {
  let restoreMemoryLimit;

  beforeEach(() => {
    restoreMemoryLimit = captureMemoryLimit();
  });

  afterEach(() => {
    restoreMemoryLimit();
  });

  function keyedChunk(values) {
    return makeChunk([{ type: 'INT32', values }]);
  }

  function recordingStorage() {
    const storage = new MemoryStorage();
    const partitions = new Set();
    const append = storage.append.bind(storage);
    storage.append = async (partitionId, buffer) => {
      partitions.add(partitionId);
      return append(partitionId, buffer);
    };
    return { storage, partitions };
  }

  it('spills its inputs instead of holding them all in memory', async () => {
    const rowCount = 4000;
    limitResidentRows([{ dataType: DataType.INT32 }], 64);

    const buildStorage = recordingStorage();
    const probeStorage = recordingStorage();
    const chunkRows = 500;
    const descending = (start) => Array.from({ length: chunkRows }, (_, i) => rowCount - (start + i));
    const buildChunks = Array.from({ length: rowCount / chunkRows }, (_, c) => keyedChunk(descending(c * chunkRows)));
    const probeChunks = Array.from({ length: rowCount / chunkRows }, (_, c) => keyedChunk(descending(c * chunkRows)));

    const sortedVia = (chunks, storage) => async function* () {
      const sortOp = new SortOperator(mergeJoinSortKeys([keyAt(0)]), null, 0, new SpillManager(storage));
      for (const chunk of chunks) await sortOp.consume(chunk);
      yield* sortOp.stream();
    };

    const op = new MergeJoinOperator(
      sortedVia(buildChunks, buildStorage.storage),
      sortedVia(probeChunks, probeStorage.storage),
      [keyAt(0)],
      [keyAt(0)],
      [DataType.INT32],
      [DataType.INT32],
      JoinType.INNER,
    );

    const rows = (await collect(op)).flatMap(c => c.toRows());

    expect(rows).toHaveLength(rowCount);
    expect(buildStorage.partitions.size).toBeGreaterThan(1);
    expect(probeStorage.partitions.size).toBeGreaterThan(1);
  });

  it('emits output in bounded batches rather than one chunk at the end', async () => {
    const rowCount = Config.flushBatchSize * 3;
    const values = Array.from({ length: rowCount }, (_, i) => i);

    const op = mergeOp([keyedChunk(values)], [keyedChunk(values)], [keyAt(0)], [keyAt(0)], JoinType.INNER);
    const chunks = await collect(op);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.size).toBeLessThanOrEqual(Config.flushBatchSize);
  });
});

describe('mergeJoinSortKeys', () => {
  const chunkWithNulls = () => makeChunk([
    { type: DataType.INT32, values: [5, null, 1] },
    { type: DataType.INT32, values: [7, 8, null] },
  ]);

  it('emits a single sort key for a single join key so radix sorting stays reachable', () => {
    const keys = mergeJoinSortKeys([keyAt(0)]);

    expect(keys).toHaveLength(1);
    expect(keys[0].direction).toBe('ASC');
    expect(keys[0].nullsFirst).toBe(true);
  });

  it('leads null join keys so the merge loop can peel them off the front', async () => {
    const chunk = chunkWithNulls();
    const sortOp = new SortOperator(mergeJoinSortKeys([keyAt(0)]), null, 0, new SpillManager(new MemoryStorage()));
    await sortOp.consume(chunk);

    const ordered = [];
    for await (const sorted of sortOp.stream()) {
      for (let row = 0; row < sorted.size; row++) ordered.push(sorted.getValue(row, 0));
    }

    expect(ordered).toEqual([null, 1, 5]);
  });

  it('prepends a null marker for composite keys so a null in any part leads', async () => {
    const keys = mergeJoinSortKeys([keyAt(0), keyAt(1)]);
    expect(keys).toHaveLength(3);

    const chunk = chunkWithNulls();
    const sortOp = new SortOperator(keys, null, 0, new SpillManager(new MemoryStorage()));
    await sortOp.consume(chunk);

    const ordered = [];
    for await (const sorted of sortOp.stream()) {
      for (let row = 0; row < sorted.size; row++) {
        ordered.push([sorted.getValue(row, 0), sorted.getValue(row, 1)]);
      }
    }

    expect(ordered.slice(0, 2).every(([a, b]) => a === null || b === null)).toBe(true);
    expect(ordered[2]).toEqual([5, 7]);
  });

  it('evaluates the composite null marker without allocating a key array per row', () => {
    const marker = mergeJoinSortKeys([keyAt(0), keyAt(1)])[0];
    const chunk = chunkWithNulls();

    expect(marker.eval(chunk, 0)).toBe(1);
    expect(marker.eval(chunk, 1)).toBe(0);
    expect(marker.eval(chunk, 2)).toBe(0);
  });
});
