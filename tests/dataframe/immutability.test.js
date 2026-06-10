import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { col, lit } from '../../src/dataframe/index.js';

let engine;

beforeEach(() => { engine = new QueryEngine(new Catalog()); });
afterEach(() => engine.close());

describe('DataFrame immutability', () => {
  it('returns a new DataFrame from each transform and leaves the parent unchanged', async () => {
    const base = engine.createDataFrame([{ id: 1, age: 10 }, { id: 2, age: 20 }]);
    const derived = base.filter(col('age').gt(lit(15)));

    expect(derived).not.toBe(base);
    expect(base.columns()).toEqual(['id', 'age']);

    const baseRows = await base.collect();
    expect(baseRows.length).toBe(2);

    const derivedRows = await derived.collect();
    expect(derivedRows.map(r => r.id)).toEqual([2]);

    const baseAgain = await base.collect();
    expect(baseAgain.length).toBe(2);
  });
});
