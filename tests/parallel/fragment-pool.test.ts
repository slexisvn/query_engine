import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FragmentPool } from '../../src/parallel/fragment-pool.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { DataType } from '../../src/storage/data-type.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { Config } from '../../src/config.js';

const pool = new FragmentPool(2, 8);
afterAll(() => pool.close());

const ALIAS = 'T';

const colRef = (name, dataType) => ({ kind: BoundExprKind.COLUMN_REF, columnName: name, tableAlias: ALIAS, dataType });
const lit = (value) => ({ kind: BoundExprKind.LITERAL, value });
const bin = (op, left, right) => ({ kind: BoundExprKind.BINARY, op, left, right, dataType: 'FLOAT64' });
const agg = (name, arg = null, distinct = false) => ({ name, distinct, args: arg ? [arg] : [] });

const SCHEMA = [
  { name: 'g', dataType: DataType.VARCHAR, tableAlias: ALIAS },
  { name: 'n', dataType: DataType.INT32, tableAlias: ALIAS },
];

function chunkFrom(schema, rows) {
  const cols = schema.map(s => s.dataType === DataType.VARCHAR
    ? new DictionaryColumn(Math.max(1, rows.length))
    : new Column(s.dataType, Math.max(1, rows.length)));
  for (const row of rows) row.forEach((v, i) => cols[i].append(v));
  return new DataChunk(cols, rows.length);
}

function specOf({ schema = SCHEMA, stages = [], groupBy = [], aggregates }) {
  return { baseSchema: schema, stages, groupBy, aggregates };
}

function toRows(chunks, names) {
  const rows = [];
  for (const chunk of chunks) {
    for (const raw of chunk.toRows()) {
      rows.push(Object.fromEntries(names.map((name, i) => [name, raw[i]])));
    }
  }
  return rows;
}

const allIndexes = (schema = SCHEMA) => schema.map((_, i) => i);

describe('FragmentPool aggregate', () => {
  it('groups by varchar with SUM/COUNT/MIN/MAX/AVG/COUNT_STAR across morsels', async () => {
    const rows = [];
    for (let i = 0; i < 50; i++) rows.push([i % 2 === 0 ? 'a' : 'b', i]);
    const chunks = [chunkFrom(SCHEMA, rows.slice(0, 20)), chunkFrom(SCHEMA, rows.slice(20))];
    const spec = specOf({
      groupBy: [colRef('g', DataType.VARCHAR)],
      aggregates: [
        agg('SUM', colRef('n', DataType.INT32)),
        agg('COUNT', colRef('n', DataType.INT32)),
        agg('MIN', colRef('n', DataType.INT32)),
        agg('MAX', colRef('n', DataType.INT32)),
        agg('AVG', colRef('n', DataType.INT32)),
        agg('COUNT_STAR'),
      ],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(), chunks), ['g', 's', 'c', 'mn', 'mx', 'av', 'cs']);
    const byG = Object.fromEntries(result.map(r => [r.g, r]));
    const evens = Array.from({ length: 25 }, (_, k) => 2 * k);
    const sum = a => a.reduce((s, x) => s + x, 0);
    expect(byG.a.s).toBe(sum(evens));
    expect(byG.a.c).toBe(25);
    expect(byG.a.mn).toBe(0);
    expect(byG.a.mx).toBe(48);
    expect(byG.a.av).toBeCloseTo(sum(evens) / 25);
    expect(byG.a.cs).toBe(25);
    expect(byG.b.mn).toBe(1);
    expect(byG.b.mx).toBe(49);
  });

  it('treats NULL group key as its own group and skips NULL agg inputs', async () => {
    const rows = [['a', 10], [null, 5], ['a', null], [null, null], ['a', 20]];
    const spec = specOf({
      groupBy: [colRef('g', DataType.VARCHAR)],
      aggregates: [agg('SUM', colRef('n', DataType.INT32)), agg('COUNT', colRef('n', DataType.INT32)), agg('COUNT_STAR')],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(), [chunkFrom(SCHEMA, rows)]), ['g', 's', 'c', 'cs']);
    const byG = new Map(result.map(r => [r.g, r]));
    expect(byG.get('a')).toMatchObject({ s: 30, c: 2, cs: 3 });
    expect(byG.get(null)).toMatchObject({ s: 5, c: 1, cs: 2 });
  });

  it('SUM/AVG over an all-null group return null', async () => {
    const rows = [['x', null], ['x', null]];
    const spec = specOf({
      groupBy: [colRef('g', DataType.VARCHAR)],
      aggregates: [agg('SUM', colRef('n', DataType.INT32)), agg('AVG', colRef('n', DataType.INT32))],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(), [chunkFrom(SCHEMA, rows)]), ['g', 's', 'av']);
    expect(result[0].s).toBeNull();
    expect(result[0].av).toBeNull();
  });

  it('applies a filter stage with 3VL (null fails the predicate)', async () => {
    const rows = [['a', 1], ['a', 5], ['a', null], ['b', 9]];
    const spec = specOf({
      stages: [{ kind: 'filter', condition: bin('>', colRef('n', DataType.INT32), lit(3)) }],
      groupBy: [colRef('g', DataType.VARCHAR)],
      aggregates: [agg('COUNT_STAR')],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(), [chunkFrom(SCHEMA, rows)]), ['g', 'cs']);
    const byG = Object.fromEntries(result.map(r => [r.g, r.cs]));
    expect(byG).toEqual({ a: 1, b: 1 });
  });

  it('returns no rows for empty grouped input', async () => {
    const spec = specOf({ groupBy: [colRef('g', DataType.VARCHAR)], aggregates: [agg('COUNT_STAR')] });
    expect(await pool.runAggregate(spec, allIndexes(), [])).toEqual([]);
  });

  it('global aggregate over zero rows returns one default row', async () => {
    const spec = specOf({
      aggregates: [agg('COUNT_STAR'), agg('SUM', colRef('n', DataType.INT32)), agg('MAX', colRef('n', DataType.INT32))],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(), []), ['cs', 's', 'mx']);
    expect(result).toEqual([{ cs: 0, s: null, mx: null }]);
  });

  it('global aggregate whose filter removes every row still returns one row', async () => {
    const rows = [['a', 1], ['b', 2]];
    const spec = specOf({
      stages: [{ kind: 'filter', condition: bin('>', colRef('n', DataType.INT32), lit(100)) }],
      aggregates: [agg('COUNT_STAR'), agg('MIN', colRef('n', DataType.INT32))],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(), [chunkFrom(SCHEMA, rows)]), ['cs', 'mn']);
    expect(result).toEqual([{ cs: 0, mn: null }]);
  });

  it('supports INT64 group keys through real operators', async () => {
    const schema = [
      { name: 'k', dataType: DataType.INT64, tableAlias: ALIAS },
      { name: 'n', dataType: DataType.INT32, tableAlias: ALIAS },
    ];
    const rows = [[1n, 3], [2n, 4], [1n, 5]];
    const spec = specOf({
      schema,
      groupBy: [colRef('k', DataType.INT64)],
      aggregates: [agg('SUM', colRef('n', DataType.INT32))],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(schema), [chunkFrom(schema, rows)]), ['k', 's']);
    const byK = Object.fromEntries(result.map(r => [r.k, r.s]));
    expect(byK[1]).toBe(8);
    expect(byK[2]).toBe(4);
  });

  it('COUNT(DISTINCT) deduplicates across chunks and workers', async () => {
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push(['a', i % 5]);
    const chunks = [chunkFrom(SCHEMA, rows.slice(0, 30)), chunkFrom(SCHEMA, rows.slice(30))];
    const spec = specOf({
      groupBy: [colRef('g', DataType.VARCHAR)],
      aggregates: [agg('COUNT', colRef('n', DataType.INT32), true)],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(), chunks), ['g', 'cd']);
    expect(result).toEqual([{ g: 'a', cd: 5 }]);
  });

  it('aggregates over computed expressions', async () => {
    const rows = [['a', 1], ['a', 2], ['b', 3]];
    const spec = specOf({
      groupBy: [colRef('g', DataType.VARCHAR)],
      aggregates: [agg('SUM', bin('*', colRef('n', DataType.INT32), lit(2)))],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(), [chunkFrom(SCHEMA, rows)]), ['g', 's']);
    const byG = Object.fromEntries(result.map(r => [r.g, r.s]));
    expect(byG).toEqual({ a: 6, b: 6 });
  });

  it('high-cardinality grouping survives the parallel radix combine path', async () => {
    const saved = Config.parallelCombineMinGroups;
    Config.parallelCombineMinGroups = 1;
    try {
      const rows = [];
      for (let i = 0; i < 4000; i++) rows.push([`g${i % 1000}`, i]);
      const chunks = [];
      for (let off = 0; off < rows.length; off += 500) {
        chunks.push(chunkFrom(SCHEMA, rows.slice(off, off + 500)));
      }
      const spec = specOf({
        groupBy: [colRef('g', DataType.VARCHAR)],
        aggregates: [agg('SUM', colRef('n', DataType.INT32)), agg('COUNT_STAR')],
      });
      const result = toRows(await pool.runAggregate(spec, allIndexes(), chunks), ['g', 's', 'cs']);
      expect(result.length).toBe(1000);
      const expected = new Map();
      for (let i = 0; i < 4000; i++) {
        const key = `g${i % 1000}`;
        expected.set(key, (expected.get(key) || 0) + i);
      }
      for (const row of result) {
        expect(row.cs).toBe(4);
        expect(row.s).toBe(expected.get(row.g));
      }
    } finally {
      Config.parallelCombineMinGroups = saved;
    }
  });

  it('spills partition partials to disk under group pressure and stays correct', async () => {
    const savedSpill = Config.aggSpillGroups;
    Config.aggSpillGroups = 16;
    const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-agg-spill-'));
    try {
      const rows = [];
      for (let i = 0; i < 3000; i++) rows.push([`g${i % 500}`, i]);
      const chunks = [];
      for (let off = 0; off < rows.length; off += 250) {
        chunks.push(chunkFrom(SCHEMA, rows.slice(off, off + 250)));
      }
      const spec = specOf({
        groupBy: [colRef('g', DataType.VARCHAR)],
        aggregates: [agg('SUM', colRef('n', DataType.INT32)), agg('COUNT_STAR')],
      });
      const result = toRows(await pool.runAggregate(spec, allIndexes(), chunks, { spillDir }), ['g', 's', 'cs']);
      expect(pool.stats.spillFiles).toBeGreaterThan(0);
      expect(fs.readdirSync(spillDir)).toEqual([]);
      expect(result.length).toBe(500);
      const expected = new Map();
      for (let i = 0; i < 3000; i++) {
        const key = `g${i % 500}`;
        expected.set(key, (expected.get(key) || 0) + i);
      }
      for (const row of result) {
        expect(row.cs).toBe(6);
        expect(row.s).toBe(expected.get(row.g));
      }
    } finally {
      Config.aggSpillGroups = savedSpill;
      fs.rmSync(spillDir, { recursive: true, force: true });
    }
  });

  it('vector path: INT32 group keys with negatives and nulls match expectations', async () => {
    const schema = [
      { name: 'k', dataType: DataType.INT32, tableAlias: ALIAS },
      { name: 'n', dataType: DataType.INT32, tableAlias: ALIAS },
    ];
    const rows = [];
    for (let i = 0; i < 400; i++) {
      rows.push([i % 7 === 0 ? null : (i % 10) - 5, i % 11 === 0 ? null : i]);
    }
    const chunks = [chunkFrom(schema, rows.slice(0, 200)), chunkFrom(schema, rows.slice(200))];
    const spec = specOf({
      schema,
      groupBy: [colRef('k', DataType.INT32)],
      aggregates: [
        agg('SUM', colRef('n', DataType.INT32)),
        agg('MIN', colRef('n', DataType.INT32)),
        agg('MAX', colRef('n', DataType.INT32)),
        agg('AVG', colRef('n', DataType.INT32)),
        agg('COUNT', colRef('n', DataType.INT32)),
        agg('COUNT_STAR'),
      ],
    });
    const result = toRows(await pool.runAggregate(spec, allIndexes(schema), chunks), ['k', 's', 'mn', 'mx', 'av', 'c', 'cs']);

    const expected = new Map();
    for (const [k, n] of rows) {
      const key = k === null ? 'null' : String(k);
      let e = expected.get(key);
      if (!e) { e = { s: null, mn: null, mx: null, c: 0, cs: 0 }; expected.set(key, e); }
      e.cs++;
      if (n !== null) {
        e.s = (e.s ?? 0) + n;
        e.mn = e.mn === null ? n : Math.min(e.mn, n);
        e.mx = e.mx === null ? n : Math.max(e.mx, n);
        e.c++;
      }
    }
    expect(result.length).toBe(expected.size);
    for (const row of result) {
      const e = expected.get(row.k === null ? 'null' : String(row.k));
      expect(row.s).toBe(e.s);
      expect(row.mn).toBe(e.mn);
      expect(row.mx).toBe(e.mx);
      expect(row.c).toBe(e.c);
      expect(row.cs).toBe(e.cs);
      expect(row.av).toBe(e.c > 0 ? e.s / e.c : null);
    }
  });

  it('degrades from vector to hash path when key range exceeds the dense limit', async () => {
    const savedRange = Config.vectorGroupRange;
    Config.vectorGroupRange = 64;
    try {
      const schema = [
        { name: 'k', dataType: DataType.INT32, tableAlias: ALIAS },
        { name: 'n', dataType: DataType.INT32, tableAlias: ALIAS },
      ];
      const rows = [];
      for (let i = 0; i < 200; i++) rows.push([i % 2 === 0 ? i % 8 : i * 100000, 1]);
      const chunks = [chunkFrom(schema, rows.slice(0, 100)), chunkFrom(schema, rows.slice(100))];
      const spec = specOf({
        schema,
        groupBy: [colRef('k', DataType.INT32)],
        aggregates: [agg('COUNT_STAR')],
      });
      const result = toRows(await pool.runAggregate(spec, allIndexes(schema), chunks), ['k', 'cs']);
      const total = result.reduce((sum, row) => sum + row.cs, 0);
      expect(total).toBe(200);
      const byK = new Map(result.map(row => [row.k, row.cs]));
      expect(byK.get(0)).toBe(25);
      expect(byK.get(2)).toBe(25);
      expect(byK.get(100000)).toBe(1);
    } finally {
      Config.vectorGroupRange = savedRange;
    }
  });

  it('vector path cooperates with partition spill', async () => {
    const savedSpill = Config.aggSpillGroups;
    Config.aggSpillGroups = 8;
    const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-vec-spill-'));
    try {
      const schema = [
        { name: 'k', dataType: DataType.INT32, tableAlias: ALIAS },
        { name: 'n', dataType: DataType.INT32, tableAlias: ALIAS },
      ];
      const rows = [];
      for (let i = 0; i < 1200; i++) rows.push([i % 300, i]);
      const chunks = [];
      for (let off = 0; off < rows.length; off += 100) {
        chunks.push(chunkFrom(schema, rows.slice(off, off + 100)));
      }
      const spec = specOf({
        schema,
        groupBy: [colRef('k', DataType.INT32)],
        aggregates: [agg('SUM', colRef('n', DataType.INT32)), agg('COUNT_STAR')],
      });
      const result = toRows(await pool.runAggregate(spec, allIndexes(schema), chunks, { spillDir }), ['k', 's', 'cs']);
      expect(pool.stats.spillFiles).toBeGreaterThan(0);
      expect(result.length).toBe(300);
      const expected = new Map();
      for (const [k, n] of rows) expected.set(k, (expected.get(k) || 0) + n);
      for (const row of result) {
        expect(row.cs).toBe(4);
        expect(row.s).toBe(expected.get(row.k));
      }
    } finally {
      Config.aggSpillGroups = savedSpill;
      fs.rmSync(spillDir, { recursive: true, force: true });
    }
  });

  it('rejects on worker-side failure but stays usable afterwards', async () => {
    const bad = specOf({ aggregates: [agg('NO_SUCH_AGG', colRef('n', DataType.INT32))] });
    await expect(pool.runAggregate(bad, allIndexes(), [chunkFrom(SCHEMA, [['a', 1]])])).rejects.toThrow();

    const ok = specOf({ aggregates: [agg('COUNT_STAR')] });
    const result = toRows(await pool.runAggregate(ok, allIndexes(), [chunkFrom(SCHEMA, [['a', 1]])]), ['cs']);
    expect(result).toEqual([{ cs: 1 }]);
  });

  it('respawns a crashed worker and serves later requests', async () => {
    const ok = specOf({ aggregates: [agg('COUNT_STAR')] });
    await pool.runAggregate(ok, allIndexes(), [chunkFrom(SCHEMA, [['a', 1]])]);

    const victim = pool.workers[0];
    await victim.worker.terminate();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(pool.workers[0]).not.toBe(victim);

    const result = toRows(await pool.runAggregate(ok, allIndexes(), [chunkFrom(SCHEMA, [['a', 1], ['b', 2]])]), ['cs']);
    expect(result).toEqual([{ cs: 2 }]);
  });
});
