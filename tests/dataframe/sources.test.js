import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { col, lit } from '../../src/dataframe/index.js';
import { DataType } from '../../src/storage/data-type.js';

let engine;

beforeEach(() => { engine = new QueryEngine(new Catalog()); });
afterEach(() => engine.close());

describe('DataFrame sources', () => {
  it('reads a registered table via engine.table', async () => {
    await engine.run('CREATE TABLE pets (id INTEGER, name VARCHAR)');
    const storage = engine.catalog.getTableStorage('PETS');
    await storage.insertRows([[1, 'rex'], [2, 'mia']]);
    const rows = await engine.table('PETS').orderBy('ID').collect();
    expect(rows.map(r => r.NAME)).toEqual(['rex', 'mia']);
  });

  it('builds from in-memory rows with a declared schema', async () => {
    const df = engine.createDataFrame([{ v: 1 }, { v: 2 }], [{ name: 'v', dataType: DataType.INT32 }]);
    expect(await df.count()).toBe(2);
  });

  it('chains a DataFrame off a SQL result', async () => {
    engine.createDataFrame([{ id: 1, city: 'HN' }, { id: 2, city: 'SG' }]);
    const df = engine.sql('SELECT id, city FROM __DF0');
    const rows = await df.filter(col('city').eq(lit('SG'))).collect();
    expect(rows).toEqual([{ id: 2, city: 'SG' }]);
  });
});
