import { describe, it, expect, beforeEach } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { registerTable } from '../../src/engine-entry.js';

function makeEngine() {
  const engine = new QueryEngine(new Catalog());
  registerTable(engine, 'ITEMS', [
    { ID: 1, PRICE: 10, LABEL: 'a' },
    { ID: 2, PRICE: 20, LABEL: 'b' },
    { ID: 3, PRICE: 30, LABEL: 'c' },
  ]);
  return engine;
}

let engine;

beforeEach(() => {
  engine = makeEngine();
});

describe('plan cache reuse', () => {
  it('returns the same compiled plan for a repeated query', async () => {
    const first = await engine.compile('SELECT ID FROM ITEMS');
    const second = await engine.compile('SELECT ID FROM ITEMS');

    expect(second).toBe(first);
  });

  it('compiles different SQL into different plans', async () => {
    const first = await engine.compile('SELECT ID FROM ITEMS');
    const second = await engine.compile('SELECT PRICE FROM ITEMS');

    expect(second).not.toBe(first);
  });

  it('reuses the plan across repeated executions', async () => {
    await engine.run('SELECT ID FROM ITEMS');
    const cachedBefore = engine.planCache.get(engine.planCacheKey('SELECT ID FROM ITEMS', []));
    await engine.run('SELECT ID FROM ITEMS');

    expect(engine.planCache.get(engine.planCacheKey('SELECT ID FROM ITEMS', []))).toBe(cachedBefore);
  });

  it('returns the same rows on a cached re-execution', async () => {
    const first = await engine.run('SELECT ID FROM ITEMS ORDER BY ID');
    const second = await engine.run('SELECT ID FROM ITEMS ORDER BY ID');

    expect(second.rows).toEqual(first.rows);
  });
});

describe('plan cache parameter sensitivity', () => {
  it('separates plans compiled with different parameter values', async () => {
    const first = await engine.compile('SELECT ID FROM ITEMS WHERE PRICE > $1', [10]);
    const second = await engine.compile('SELECT ID FROM ITEMS WHERE PRICE > $1', [20]);

    expect(second).not.toBe(first);
  });

  it('reuses the plan for identical parameter values', async () => {
    const first = await engine.compile('SELECT ID FROM ITEMS WHERE PRICE > $1', [10]);
    const second = await engine.compile('SELECT ID FROM ITEMS WHERE PRICE > $1', [10]);

    expect(second).toBe(first);
  });

  it('produces the right rows for each parameter value', async () => {
    const cheap = await engine.run('SELECT ID FROM ITEMS WHERE PRICE > $1', [10]);
    const dear = await engine.run('SELECT ID FROM ITEMS WHERE PRICE > $1', [20]);

    expect(cheap.rows).toHaveLength(2);
    expect(dear.rows).toHaveLength(1);
  });

  it('separates a numeric parameter from its string form', async () => {
    const numeric = await engine.compile('SELECT ID FROM ITEMS WHERE LABEL = $1', ['1']);
    const text = await engine.compile('SELECT ID FROM ITEMS WHERE LABEL = $1', [1]);

    expect(text).not.toBe(numeric);
  });
});

describe('plan cache invalidation', () => {
  it('discards cached plans after a table is created', async () => {
    const first = await engine.compile('SELECT ID FROM ITEMS');
    await engine.run('CREATE TABLE OTHER (X INTEGER)');
    const second = await engine.compile('SELECT ID FROM ITEMS');

    expect(second).not.toBe(first);
  });

  it('discards cached plans after a table is dropped', async () => {
    await engine.run('CREATE TABLE TEMP_T (X INTEGER)');
    const first = await engine.compile('SELECT ID FROM ITEMS');
    await engine.run('DROP TABLE TEMP_T');
    const second = await engine.compile('SELECT ID FROM ITEMS');

    expect(second).not.toBe(first);
  });

  it('still answers correctly after the schema changes', async () => {
    await engine.run('SELECT ID FROM ITEMS');
    await engine.run('CREATE TABLE OTHER (X INTEGER)');
    const rows = (await engine.run('SELECT ID FROM ITEMS ORDER BY ID')).rows;

    expect(rows.map(r => r.ID)).toEqual([1, 2, 3]);
  });

  it('does not cache explain statements', async () => {
    await engine.run('EXPLAIN SELECT ID FROM ITEMS');
    expect(engine.planCache.get(engine.planCacheKey('EXPLAIN SELECT ID FROM ITEMS', []))).toBeUndefined();
  });

  it('does not cache DDL statements', async () => {
    await engine.run('CREATE TABLE DDL_T (X INTEGER)');
    expect(engine.planCache.get(engine.planCacheKey('CREATE TABLE DDL_T (X INTEGER)', []))).toBeUndefined();
  });
});

describe('plan cache bounds', () => {
  it('keeps the cache within its configured size', async () => {
    for (let i = 0; i < 400; i++) {
      await engine.compile(`SELECT ID FROM ITEMS WHERE PRICE > ${i}`);
    }

    expect(engine.planCache._map.size).toBeLessThanOrEqual(256);
  });

  it('still serves a recently used plan after eviction pressure', async () => {
    const hot = 'SELECT ID FROM ITEMS WHERE PRICE > 1';
    for (let i = 0; i < 300; i++) {
      await engine.compile(`SELECT ID FROM ITEMS WHERE PRICE > ${i + 1000}`);
      await engine.compile(hot);
    }

    const first = await engine.compile(hot);
    const second = await engine.compile(hot);
    expect(second).toBe(first);
  });
});
