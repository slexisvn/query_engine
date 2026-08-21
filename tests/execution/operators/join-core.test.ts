import { describe, it, expect } from 'vitest';
import {
  joinKeyOf,
  joinKeyHash,
  joinKeyValues,
  probeJoinInto,
  emitsOnUnmatchedProbe,
  emitsUnmatchedBuild,
  JoinOutputBuffer,
  materializeRow,
} from '../../../src/execution/operators/join-core.js';
import { JoinType } from '../../../src/planner/logical-plan.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { SabArena } from '../../../src/storage/sab-arena.js';
import { createKeyedHashTable } from '../../../src/execution/hash-table.js';

function tableOf(buildRows) {
  const map = new Map();
  buildRows.forEach((entry, idx) => {
    const [key, ...row] = entry;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push({ row: [key, ...row], idx });
  });
  return map;
}

function probe(items, table, joinType, extra = {}) {
  const output = new JoinOutputBuffer({ joinType, buildColCount: 2, probeColCount: 2 });
  probeJoinInto(
    items.map(([key, ...row]) => ({ key, row: [key, ...row] })),
    (key) => table.get(key) || null,
    {
      joinType,
      buildColCount: 2,
      probeColCount: 2,
      conditionEvaluator: null,
      hasNullKey: false,
      ...extra,
    },
    output,
  );
  return output.toChunk(0, output.length).toRows();
}

function markRows(conditionEvaluator) {
  const build = new Map([[1, [{ row: [1, 'b1'] }]]]);
  const output = new JoinOutputBuffer({ joinType: JoinType.MARK, buildColCount: 2, probeColCount: 2 });
  probeJoinInto(
    [{ row: [1, 'p1'], key: 1 }],
    (key) => build.get(key) || null,
    {
      joinType: JoinType.MARK,
      buildColCount: 2,
      probeColCount: 2,
      conditionEvaluator,
      hasNullKey: false,
      onMatched: null,
    },
    output,
  );
  return output.toChunk(0, output.length).toRows();
}

describe('joinKeyOf', () => {
  const col = (values) => ({ get: (i) => values[i] });
  const chunkLike = (...cols) => ({ columns: cols.map(col) });
  const scratch = [null];

  it('nulls out a single key on null and treats a bigint as its numeric equal', () => {
    const chunk = chunkLike([5, null, 5n]);
    const extractor = (c, r) => c.columns[0].get(r);
    expect(joinKeyOf([extractor], chunk, 1)).toBeNull();

    const table = createKeyedHashTable(1);
    const entryOf = (row) => table.findOrInsert(joinKeyValues(joinKeyOf([extractor], chunk, row), scratch));
    expect(entryOf(0)).toBe(entryOf(2));
  });

  it('nulls out a multi-part key when any part is null', () => {
    const chunk = chunkLike([1, 1], ['a', null]);
    const extractors = [(c, r) => c.columns[0].get(r), (c, r) => c.columns[1].get(r)];
    expect(joinKeyOf(extractors, chunk, 0)).not.toBeNull();
    expect(joinKeyOf(extractors, chunk, 1)).toBeNull();
  });

  it('gives equal multi-part keys to equal tuples and distinct keys to distinct tuples', () => {
    const chunk = chunkLike([1, 1, 2], ['a', 'a', 'a']);
    const extractors = [(c, r) => c.columns[0].get(r), (c, r) => c.columns[1].get(r)];
    const table = createKeyedHashTable(2);
    const entryOf = (row) => table.findOrInsert(joinKeyOf(extractors, chunk, row));
    expect(entryOf(0)).toBe(entryOf(1));
    expect(entryOf(0)).not.toBe(entryOf(2));
  });

  it('does not collide tuples that differ only in where a separator-like character falls', () => {
    const chunk = chunkLike(['a|b', 'a'], ['c', 'b|c']);
    const extractors = [(c, r) => c.columns[0].get(r), (c, r) => c.columns[1].get(r)];
    expect(joinKeyOf(extractors, chunk, 0)).not.toBe(joinKeyOf(extractors, chunk, 1));
  });
});

describe('probeJoinInto semantics', () => {
  const build = tableOf([[1, 'b1'], [1, 'b1x'], [2, 'b2']]);

  it('INNER emits one row per matching build row and drops unmatched/null', () => {
    const rows = probe([[1, 'p1'], [3, 'p3'], [null, 'pn']], build, JoinType.INNER);
    expect(rows).toEqual([
      [1, 'b1', 1, 'p1'],
      [1, 'b1x', 1, 'p1'],
    ]);
  });

  it('LEFT pads unmatched and null-key probe rows with build nulls', () => {
    const rows = probe([[3, 'p3'], [null, 'pn']], build, JoinType.LEFT);
    expect(rows).toEqual([
      [null, null, 3, 'p3'],
      [null, null, null, 'pn'],
    ]);
  });

  it('SEMI emits each matched probe row exactly once', () => {
    const rows = probe([[1, 'p1'], [2, 'p2'], [3, 'p3']], build, JoinType.SEMI);
    expect(rows).toEqual([
      [1, 'p1'],
      [2, 'p2'],
    ]);
  });

  it('ANTI emits only unmatched probe rows', () => {
    const rows = probe([[1, 'p1'], [3, 'p3']], build, JoinType.ANTI);
    expect(rows).toEqual([[3, 'p3']]);
  });

  it('ANTI keeps a null-key probe row at probe width', () => {
    const rows = probe([[3, 'p3'], [null, 'pn']], build, JoinType.ANTI);
    expect(rows).toEqual([
      [3, 'p3'],
      [null, 'pn'],
    ]);
  });

  it('MARK keeps a null-key probe row and marks it unknown', () => {
    const rows = probe([[3, 'p3'], [null, 'pn']], build, JoinType.MARK);
    expect(rows).toEqual([
      [3, 'p3', false],
      [null, 'pn', null],
    ]);
  });

  it('MARK appends true/false, or null when the build side saw null keys', () => {
    expect(probe([[1, 'p1'], [3, 'p3']], build, JoinType.MARK)).toEqual([
      [1, 'p1', true],
      [3, 'p3', false],
    ]);
    expect(probe([[3, 'p3']], build, JoinType.MARK, { hasNullKey: true })).toEqual([
      [3, 'p3', null],
    ]);
  });

  it('SINGLE emits at most one match and pads unmatched rows', () => {
    const rows = probe([[1, 'p1'], [3, 'p3']], build, JoinType.SINGLE);
    expect(rows).toEqual([
      [1, 'b1', 1, 'p1'],
      [null, null, 3, 'p3'],
    ]);
  });

  it('marks every matched build row for unmatched-build tracking', () => {
    const matched = new Set();
    probe([[1, 'p1']], build, JoinType.FULL, { onMatched: (item) => matched.add(item.idx) });
    expect(matched).toEqual(new Set([0, 1]));
  });

  it('applies the residual condition over the combined row', () => {
    const evaluator = (adapter) => adapter.columns[1].get() === 'b1';
    const rows = probe([[1, 'p1']], build, JoinType.INNER, { conditionEvaluator: evaluator });
    expect(rows).toEqual([[1, 'b1', 1, 'p1']]);
  });
});

describe('join helper predicates', () => {
  it('classifies unmatched-emission by join type', () => {
    for (const jt of [JoinType.LEFT, JoinType.FULL, JoinType.SINGLE, JoinType.ANTI, JoinType.MARK]) {
      expect(emitsOnUnmatchedProbe(jt)).toBe(true);
    }
    expect(emitsOnUnmatchedProbe(JoinType.INNER)).toBe(false);
    expect(emitsOnUnmatchedProbe(JoinType.SEMI)).toBe(false);

    expect(emitsUnmatchedBuild(JoinType.LEFT)).toBe(true);
    expect(emitsUnmatchedBuild(JoinType.FULL)).toBe(true);
    expect(emitsUnmatchedBuild(JoinType.INNER)).toBe(false);
    expect(emitsUnmatchedBuild(JoinType.SEMI)).toBe(false);
  });

  it('hashes a key deterministically and keeps 5 apart from the string "5"', () => {
    const scratchA = [null];
    const scratchB = [null];
    expect(joinKeyHash(5, scratchA)).toBe(joinKeyHash(5, scratchB));
    expect(joinKeyHash('abc', scratchA)).toBe(joinKeyHash('abc', scratchB));
    expect(joinKeyHash(5n, scratchA)).toBe(joinKeyHash(5, scratchB));
    expect(joinKeyHash(5, scratchA)).not.toBe(joinKeyHash('5', scratchB));
    expect(typeof joinKeyHash(1.5, scratchA)).toBe('number');
  });
});

describe('probeJoinInto three-valued mark', () => {
  it('marks unknown when a residual condition never resolves', () => {
    expect(markRows(() => null)).toEqual([[1, 'p1', null]]);
  });

  it('marks false when the residual condition resolves to false', () => {
    expect(markRows(() => false)).toEqual([[1, 'p1', false]]);
  });
});

describe('JoinOutputBuffer', () => {
  function bufferOf(layout, entries) {
    const output = new JoinOutputBuffer(layout);
    for (const [build, probeRow, mark] of entries) output.push(build, probeRow, mark);
    return output;
  }

  it('uses provided schemas for build/probe halves and BOOLEAN for the mark column', () => {
    const output = bufferOf(
      { joinType: JoinType.MARK, buildColCount: 0, probeColCount: 2, buildSchema: null, probeSchema: ['INT32', 'VARCHAR'] },
      [[null, [7, 'a'], true], [null, [null, 'b'], false]],
    );

    const chunk = output.toChunk(0, output.length);

    expect(chunk.toRows()).toEqual([[7, 'a', true], [null, 'b', false]]);
    expect(chunk.columns[2].dataType).toBe('BOOLEAN');
    expect(chunk.columns[0].dataType).toBe('INT32');
  });

  it('types every mark-join column from the probe schema', () => {
    const output = bufferOf(
      { joinType: JoinType.MARK, buildColCount: 2, probeColCount: 2, buildSchema: ['INT32', 'INT32'], probeSchema: ['INT32', 'VARCHAR'] },
      [[null, [30, 'hr'], false]],
    );

    const chunk = output.toChunk(0, output.length);

    expect(chunk.toRows()).toEqual([[30, 'hr', false]]);
    expect(chunk.columns.map(c => c.dataType)).toEqual(['INT32', 'VARCHAR', 'BOOLEAN']);
  });

  it('builds inner-join output with declared types and null padding intact', () => {
    const output = bufferOf(
      { joinType: JoinType.INNER, buildColCount: 2, probeColCount: 2, buildSchema: ['INT32', 'VARCHAR'], probeSchema: ['INT32', 'FLOAT64'] },
      [[[1, 'x'], [10, 2.5]], [null, [20, -1.5]]],
    );

    const chunk = output.toChunk(0, output.length);

    expect(chunk.toRows()).toEqual([[1, 'x', 10, 2.5], [null, null, 20, -1.5]]);
    expect(chunk.columns.map(c => c.dataType)).toEqual(['INT32', 'VARCHAR', 'INT32', 'FLOAT64']);
  });

  it('pads the probe half of an unmatched build row with nulls', () => {
    const output = bufferOf(
      { joinType: JoinType.LEFT, buildColCount: 2, probeColCount: 2, buildSchema: ['INT32', 'VARCHAR'], probeSchema: ['INT32', 'VARCHAR'] },
      [[[1, 'x'], null]],
    );

    expect(output.toChunk(0, output.length).toRows()).toEqual([[1, 'x', null, null]]);
  });

  it('infers a column type from the data when no schema declares it', () => {
    const output = bufferOf(
      { joinType: JoinType.INNER, buildColCount: 1, probeColCount: 1 },
      [[[null], ['a']], [[2.5], ['b']]],
    );

    const chunk = output.toChunk(0, output.length);

    expect(chunk.columns.map(c => c.dataType)).toEqual(['FLOAT64', 'VARCHAR']);
    expect(chunk.toRows()).toEqual([[null, 'a'], [2.5, 'b']]);
  });

  it('splits accumulated rows into batches without losing or reordering any', () => {
    const entries = [];
    for (let i = 0; i < 7; i++) entries.push([[i], [`p${i}`]]);
    const output = bufferOf(
      { joinType: JoinType.INNER, buildColCount: 1, probeColCount: 1, buildSchema: ['INT32'], probeSchema: ['VARCHAR'] },
      entries,
    );

    const chunks = [...output.chunks(3)];

    expect(chunks.map(c => c.size)).toEqual([3, 3, 1]);
    expect(chunks.flatMap(c => c.toRows())).toEqual(entries.map(([b, p]) => [b[0], p[0]]));
  });

  it('allocates columns on a shared arena when given one', () => {
    const arena = new SabArena(4096);
    const output = bufferOf(
      { joinType: JoinType.INNER, buildColCount: 1, probeColCount: 1, buildSchema: ['INT32'], probeSchema: ['VARCHAR'] },
      [[[1], ['a']], [[2], ['b']]],
    );

    const chunk = output.toChunk(0, output.length, arena);

    expect(chunk.columns[0].data.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(chunk.columns[1].stringBytes.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(chunk.toRows()).toEqual([[1, 'a'], [2, 'b']]);
  });
});
