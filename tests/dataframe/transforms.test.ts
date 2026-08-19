import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { col, lit } from '../../src/dataframe/index.js';

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

describe('DataFrame transforms', () => {
  it('select projects and renames columns', async () => {
    const rows = await df.select('id', col('age').alias('years')).collect();
    expect(rows[0]).toEqual({ id: 1, years: 30 });
  });

  it('filter accepts a column expression', async () => {
    const rows = await df.filter(col('age').ge(lit(18))).select('id').collect();
    expect(rows.map(r => r.id)).toEqual([1, 3, 4]);
  });

  it('where accepts a raw SQL predicate', async () => {
    const rows = await df.where("city = 'HN' AND age > 18").select('id').collect();
    expect(rows.map(r => r.id)).toEqual([1]);
  });

  it('withColumn adds a computed column', async () => {
    const rows = await df.withColumn('double', col('spend').mul(lit(2))).select('id', 'double').collect();
    expect(rows[0]).toEqual({ id: 1, double: 200 });
  });

  it('withColumn replaces an existing column in place', async () => {
    const rows = await df.withColumn('age', col('age').add(lit(1))).select('id', 'age').collect();
    expect(rows[0]).toEqual({ id: 1, age: 31 });
    expect(Object.keys(rows[0])).toEqual(['id', 'age']);
  });

  it('drop removes columns', async () => {
    const rows = await df.drop('spend', 'age').collect();
    expect(Object.keys(rows[0])).toEqual(['id', 'city']);
  });

  it('orderBy sorts ascending and descending', async () => {
    const asc = await df.orderBy('age').select('id').collect();
    expect(asc.map(r => r.id)).toEqual([2, 4, 1, 3]);
    const desc = await df.orderBy({ col: 'age', desc: true }).select('id').collect();
    expect(desc.map(r => r.id)).toEqual([3, 1, 4, 2]);
  });

  it('the last orderBy wins when chained, then limit', async () => {
    const desc = await df.orderBy('age').orderBy({ col: 'age', desc: true }).limit(2).select('id').collect();
    expect(desc.map(r => r.id)).toEqual([3, 1]);
    const asc = await df.orderBy({ col: 'age', desc: true }).orderBy('age').limit(2).select('id').collect();
    expect(asc.map(r => r.id)).toEqual([2, 4]);
  });

  it('limit with offset slices results', async () => {
    const rows = await df.orderBy('id').limit(2, 1).collect();
    expect(rows.map(r => r.id)).toEqual([2, 3]);
  });

  it('distinct removes duplicates', async () => {
    const rows = await df.select('city').distinct().orderBy('city').collect();
    expect(rows.map(r => r.city)).toEqual(['HN', 'SG']);
  });

  it('count returns the row count', async () => {
    expect(await df.filter(col('age').ge(lit(18))).count()).toBe(3);
  });

  it('streams chunks', async () => {
    let seen = 0;
    for await (const chunk of df.chunks()) seen += chunk.size;
    expect(seen).toBe(4);
  });
});
