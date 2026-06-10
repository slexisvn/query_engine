import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { col, lit, sum } from '../../src/dataframe/index.js';

const DATA = [
  { id: 1, city: 'HN', age: 30, spend: 100 },
  { id: 2, city: 'HN', age: 17, spend: 50 },
  { id: 3, city: 'SG', age: 40, spend: 200 },
  { id: 4, city: 'SG', age: 22, spend: 75 },
];

let engine;
let df;

beforeEach(() => {
  engine = new QueryEngine(new Catalog());
  df = engine.createDataFrame(DATA);
});

afterEach(() => engine.close());

function sortRows(rows) {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('DataFrame / SQL equivalence', () => {
  it('matches a filter + projection query', async () => {
    const dfRows = await df.filter(col('age').ge(lit(18))).select('id', 'city').collect();
    const sqlRows = (await engine.run('SELECT id, city FROM __DF0 WHERE age >= 18')).rows;
    expect(sortRows(dfRows)).toEqual(sortRows(sqlRows));
  });

  it('matches a grouped aggregate query', async () => {
    const dfRows = await df.groupBy('city').agg(sum('spend').alias('total')).collect();
    const sqlRows = (await engine.run('SELECT city, SUM(spend) AS total FROM __DF0 GROUP BY city')).rows;
    expect(sortRows(dfRows)).toEqual(sortRows(sqlRows));
  });

  it('matches an ordered + limited query', async () => {
    const dfRows = await df.orderBy({ col: 'spend', desc: true }).limit(2).select('id').collect();
    const sqlRows = (await engine.run('SELECT id FROM __DF0 ORDER BY spend DESC LIMIT 2')).rows;
    expect(dfRows).toEqual(sqlRows);
  });
});
