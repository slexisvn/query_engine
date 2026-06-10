import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';

let engine;

beforeEach(() => { engine = new QueryEngine(new Catalog()); });
afterEach(() => engine.close());

describe('DataFrame join', () => {
  it('inner joins on a shared key and dedupes the key column', async () => {
    const a = engine.createDataFrame([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    const b = engine.createDataFrame([{ id: 1, score: 10 }, { id: 2, score: 20 }]);
    const joined = a.join(b, 'id');
    expect(joined.columns()).toEqual(['id', 'name', 'score']);
    const rows = await joined.orderBy('id').collect();
    expect(rows).toEqual([
      { id: 1, name: 'a', score: 10 },
      { id: 2, name: 'b', score: 20 },
    ]);
  });

  it('pins output order to [left, right]', async () => {
    const a = engine.createDataFrame([{ k: 1, l: 'x' }]);
    const b = engine.createDataFrame([{ k: 1, r: 'y' }]);
    const joined = a.join(b, 'k');
    expect(joined.columns()).toEqual(['k', 'l', 'r']);
  });

  it('left join keeps unmatched left rows', async () => {
    const a = engine.createDataFrame([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    const b = engine.createDataFrame([{ id: 1, score: 10 }]);
    const rows = await a.join(b, 'id', 'LEFT').orderBy('id').collect();
    expect(rows).toEqual([
      { id: 1, name: 'a', score: 10 },
      { id: 2, name: 'b', score: null },
    ]);
  });

  it('right join keeps unmatched right rows with coalesced keys', async () => {
    const a = engine.createDataFrame([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    const b = engine.createDataFrame([{ id: 1, score: 10 }, { id: 3, score: 30 }]);
    const rows = await a.join(b, 'id', 'RIGHT').orderBy('id').collect();
    expect(rows).toEqual([
      { id: 1, name: 'a', score: 10 },
      { id: 3, name: null, score: 30 },
    ]);
  });

  it('full join keeps both unmatched sides with coalesced keys', async () => {
    const a = engine.createDataFrame([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    const b = engine.createDataFrame([{ id: 1, score: 10 }, { id: 3, score: 30 }]);
    const rows = await a.join(b, 'id', 'FULL').orderBy('id').collect();
    expect(rows).toEqual([
      { id: 1, name: 'a', score: 10 },
      { id: 2, name: 'b', score: null },
      { id: 3, name: null, score: 30 },
    ]);
  });

  it('null join keys never match (inner)', async () => {
    const a = engine.createDataFrame([{ id: 1, name: 'a' }, { id: null, name: 'x' }]);
    const b = engine.createDataFrame([{ id: 1, score: 10 }, { id: null, score: 99 }]);
    const rows = await a.join(b, 'id').collect();
    expect(rows).toEqual([{ id: 1, name: 'a', score: 10 }]);
  });

  it('full join keeps null-keyed rows from both sides unmatched', async () => {
    const a = engine.createDataFrame([{ id: 1, name: 'a' }, { id: null, name: 'x' }]);
    const b = engine.createDataFrame([{ id: 1, score: 10 }, { id: null, score: 99 }]);
    const rows = await a.join(b, 'id', 'FULL').collect();
    const norm = [...rows].sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q)));
    expect(norm).toEqual([...[
      { id: 1, name: 'a', score: 10 },
      { id: null, name: 'x', score: null },
      { id: null, name: null, score: 99 },
    ]].sort((p, q) => JSON.stringify(p).localeCompare(JSON.stringify(q))));
  });

  it('coalesces the join key with a numeric type when one side key is all-null', async () => {
    const a = engine.createDataFrame([{ id: null, name: 'a' }]);
    const b = engine.createDataFrame([{ id: 1, score: 10 }, { id: 2, score: 20 }]);
    const rows = await a.join(b, 'id', 'RIGHT').orderBy('id').collect();
    expect(rows).toEqual([
      { id: 1, name: null, score: 10 },
      { id: 2, name: null, score: 20 },
    ]);
    expect(typeof rows[0].id).toBe('number');
  });

  it('supports self joins', async () => {
    const a = engine.createDataFrame([{ id: 1, v: 'x' }, { id: 2, v: 'y' }]);
    const rows = await a.join(a, 'id').orderBy('id').collect();
    expect(rows.map(r => r.id)).toEqual([1, 2]);
    expect(rows[0].v).toBe('x');
  });
});
