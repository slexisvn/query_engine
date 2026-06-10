import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { col, sum, avg, count, countStar } from '../../src/dataframe/index.js';

const DATA = [
  { city: 'HN', spend: 100, age: 30 },
  { city: 'HN', spend: 50, age: 20 },
  { city: 'SG', spend: 200, age: 40 },
];

let engine;
let df;

beforeEach(() => {
  engine = new QueryEngine(new Catalog());
  df = engine.createDataFrame(DATA);
});

afterEach(() => engine.close());

describe('groupBy / agg', () => {
  it('aggregates with a group output schema of [groups, aggs]', async () => {
    const grouped = df.groupBy('city').agg(sum('spend').alias('total'), avg('age').alias('avg_age'));
    expect(grouped.columns()).toEqual(['city', 'total', 'avg_age']);
    const rows = await grouped.orderBy('city').collect();
    expect(rows).toEqual([
      { city: 'HN', total: 150, avg_age: 25 },
      { city: 'SG', total: 200, avg_age: 40 },
    ]);
  });

  it('supports count and countStar', async () => {
    const rows = await df.groupBy('city')
      .agg(count('spend').alias('n'), countStar().alias('all'))
      .orderBy('city').collect();
    expect(rows[0]).toEqual({ city: 'HN', n: 2, all: 2 });
  });

  it('allows selecting an aggregate result downstream', async () => {
    const rows = await df.groupBy('city')
      .agg(sum('spend').alias('total'))
      .filter(col('total').gt(150))
      .collect();
    expect(rows).toEqual([{ city: 'SG', total: 200 }]);
  });

  it('filters correctly after a reordering select over the aggregate', async () => {
    const rows = await df.groupBy('city')
      .agg(sum('spend').alias('total'))
      .select('total', 'city')
      .filter(col('total').le(150))
      .collect();
    expect(rows).toEqual([{ total: 150, city: 'HN' }]);
  });
});
