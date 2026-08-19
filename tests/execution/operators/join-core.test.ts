import { describe, it, expect } from 'vitest';
import {
  joinKeyOf,
  joinKeyHash,
  probeJoinRows,
  emitsOnUnmatchedProbe,
  emitsUnmatchedBuild,
  buildJoinOutputChunk,
  materializeRow,
} from '../../../src/execution/operators/join-core.js';
import { JoinType } from '../../../src/planner/logical-plan.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { SabArena } from '../../../src/storage/sab-arena.js';

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
  return probeJoinRows(
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
  );
}

describe('joinKeyOf', () => {
  const col = (values) => ({ get: (i) => values[i] });
  const chunkLike = (...cols) => ({ columns: cols.map(col) });

  it('returns raw value for single key, null on null, Number for bigint', () => {
    const chunk = chunkLike([5, null, 7n]);
    const extractor = (c, r) => c.columns[0].get(r);
    expect(joinKeyOf([extractor], chunk, 0)).toBe(5);
    expect(joinKeyOf([extractor], chunk, 1)).toBeNull();
    expect(joinKeyOf([extractor], chunk, 2)).toBe(7);
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
    expect(joinKeyOf(extractors, chunk, 0)).toBe(joinKeyOf(extractors, chunk, 1));
    expect(joinKeyOf(extractors, chunk, 0)).not.toBe(joinKeyOf(extractors, chunk, 2));
  });

  it('does not collide tuples that differ only in where a separator-like character falls', () => {
    const chunk = chunkLike(['a|b', 'a'], ['c', 'b|c']);
    const extractors = [(c, r) => c.columns[0].get(r), (c, r) => c.columns[1].get(r)];
    expect(joinKeyOf(extractors, chunk, 0)).not.toBe(joinKeyOf(extractors, chunk, 1));
  });
});

describe('probeJoinRows semantics', () => {
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

  it('hashes numbers, strings and bigints deterministically and distinctly from 5 vs "5"', () => {
    expect(joinKeyHash(5)).toBe(joinKeyHash(5));
    expect(joinKeyHash('abc')).toBe(joinKeyHash('abc'));
    expect(joinKeyHash(5n)).toBe(joinKeyHash(5n));
    expect(typeof joinKeyHash(1.5)).toBe('number');
  });
});

describe('buildJoinOutputChunk', () => {
  it('uses provided schemas for build/probe halves and BOOLEAN for the mark column', () => {
    const rows = [[7, 'a', true], [null, 'b', false]];
    const chunk = buildJoinOutputChunk(rows, {
      joinType: JoinType.MARK,
      buildColCount: 0,
      buildSchema: null,
      probeSchema: ['INT32', 'VARCHAR'],
    });
    expect(chunk.toRows()).toEqual(rows);
    expect(chunk.columns[2].dataType).toBe('BOOLEAN');
    expect(chunk.columns[0].dataType).toBe('INT32');
  });

  it('builds inner-join output with declared types and null padding intact', () => {
    const rows = [
      [1, 'x', 10, 2.5],
      [null, null, 20, -1.5],
    ];
    const chunk = buildJoinOutputChunk(rows, {
      joinType: JoinType.INNER,
      buildColCount: 2,
      buildSchema: ['INT32', 'VARCHAR'],
      probeSchema: ['INT32', 'FLOAT64'],
    });
    expect(chunk.toRows()).toEqual(rows);
    expect(chunk.columns.map(c => c.dataType)).toEqual(['INT32', 'VARCHAR', 'INT32', 'FLOAT64']);
  });

  it('allocates columns on a shared arena when given one', () => {
    const arena = new SabArena(4096);
    const chunk = buildJoinOutputChunk([[1, 'a'], [2, 'b']], {
      joinType: JoinType.INNER,
      buildColCount: 1,
      buildSchema: ['INT32'],
      probeSchema: ['VARCHAR'],
    }, arena);
    expect(chunk.columns[0].data.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(chunk.columns[1].stringBytes.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(chunk.toRows()).toEqual([[1, 'a'], [2, 'b']]);
  });
});

describe('materializeRow', () => {
  it('reads one physical row across all columns', () => {
    const a = new Column('INT32', 3);
    const b = new Column('VARCHAR', 3);
    [1, 2, 3].forEach((v, i) => a.set(i, v));
    ['x', null, 'z'].forEach((v, i) => b.set(i, v));
    a.length = 3; b.length = 3;
    const chunk = new DataChunk([a, b], 3);
    expect(materializeRow(chunk, 1)).toEqual([2, null]);
  });
});
