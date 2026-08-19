import { describe, it, expect, afterEach } from 'vitest';
import {
  createEngine,
  registerTable,
  registerStreamingTable,
  InMemoryRelation,
  RelationBuilder,
} from '../../src/index.js';
import { DataType } from '../../src/storage/data-type.js';

async function collect(relation) {
  const rows = [];
  const schema = relation.getSchema();
  for await (const chunk of relation.scan()) {
    for (let i = 0; i < chunk.size; i++) {
      const row = {};
      for (let j = 0; j < schema.length; j++) row[schema[j].name] = chunk.columns[j].get(i);
      rows.push(row);
    }
  }
  return rows;
}

function batch(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const SCHEMA = [
  { name: 'id', dataType: DataType.INT32 },
  { name: 'city', dataType: DataType.VARCHAR },
  { name: 'amount', dataType: DataType.FLOAT64 },
];

const DATASET = [
  { id: 1, city: 'HN', amount: 10.5 },
  { id: 2, city: 'SG', amount: 20.0 },
  { id: 3, city: 'HN', amount: null },
  { id: 4, city: 'SG', amount: 5.25 },
  { id: 5, city: 'HN', amount: 4.0 },
];

const COLUMNS = {
  id: DATASET.map(r => r.id),
  city: DATASET.map(r => r.city),
  amount: DATASET.map(r => r.amount),
};

describe('incremental relation builder', () => {
  let engines = [];
  afterEach(() => { engines.forEach(e => e.close()); engines = []; });
  const newEngine = () => { const e = createEngine(); engines.push(e); return e; };

  it('builds the same chunks incrementally as fromColumns', async () => {
    const builder = InMemoryRelation.builder(SCHEMA);
    for (const b of batch(DATASET, 2)) builder.appendRows(b);
    const incremental = builder.finish();

    const whole = InMemoryRelation.fromColumns(COLUMNS, SCHEMA);
    expect(await collect(incremental)).toEqual(await collect(whole));
    expect(incremental.getSchema()).toEqual(whole.getSchema());
  });

  it('rotates chunks at the chunk boundary instead of holding one row array', async () => {
    const rows = Array.from({ length: 4100 }, (_, i) => ({ x: i }));
    const builder = InMemoryRelation.builder([{ name: 'x', dataType: DataType.INT32 }]);
    for (const b of batch(rows, 500)) builder.appendRows(b);
    const rel = builder.finish();
    expect(rel.rowCount()).toBe(4100);
    expect(rel.chunks.length).toBe(3);
    expect(rel.chunks.every(c => c.size <= 2048)).toBe(true);
    const out = await collect(rel);
    expect(out[4099].x).toBe(4099);
  });

  it('infers the schema from the first batch when none is given', async () => {
    const builder = InMemoryRelation.builder();
    builder.appendRows([{ id: 1, city: 'HN' }]);
    builder.appendRows([{ id: 2, city: 'SG' }]);
    const rel = builder.finish();
    expect(rel.getSchema().map(c => c.dataType)).toEqual([DataType.INT32, DataType.VARCHAR]);
  });

  it('preserves null semantics across batches', async () => {
    const builder = InMemoryRelation.builder([{ name: 'amount', dataType: DataType.FLOAT64 }]);
    builder.appendRows([{ amount: 1.5 }, { amount: null }]);
    builder.appendRows([{ amount: null }, { amount: 2.5 }]);
    expect(await collect(builder.finish())).toEqual([
      { amount: 1.5 }, { amount: null }, { amount: null }, { amount: 2.5 },
    ]);
  });

  it('rejects use after finish()', () => {
    const builder = InMemoryRelation.builder(SCHEMA);
    builder.finish();
    expect(() => builder.appendRows([{ id: 1, city: 'HN', amount: 1 }])).toThrow();
    expect(() => builder.finish()).toThrow();
  });

  it('is a RelationBuilder instance via InMemoryRelation.builder', () => {
    expect(InMemoryRelation.builder(SCHEMA)).toBeInstanceOf(RelationBuilder);
  });

  it('registerStreamingTable matches registerTable on SQL queries', async () => {
    async function* source() {
      for (const b of batch(DATASET, 2)) yield b;
    }

    const streamed = newEngine();
    await registerStreamingTable(streamed, 't', SCHEMA, source());

    const whole = newEngine();
    registerTable(whole, 't', DATASET, SCHEMA);

    const queries = [
      'SELECT id, city FROM t',
      'SELECT id FROM t WHERE city = \'HN\'',
      'SELECT city, COUNT(*) c, SUM(amount) s FROM t GROUP BY city ORDER BY city',
      'SELECT amount FROM t WHERE amount IS NULL',
    ];
    for (const q of queries) {
      const a = await streamed.sql(q).collect();
      const b = await whole.sql(q).collect();
      expect(a).toEqual(b);
    }
  });

  it('accepts a 3-arg form with schema inferred from the stream', async () => {
    async function* source() {
      yield [{ id: 1, city: 'HN' }];
      yield [{ id: 2, city: 'SG' }];
    }
    const engine = newEngine();
    await registerStreamingTable(engine, 'inferred', source());
    const rows = await engine.sql('SELECT id, city FROM inferred ORDER BY id').collect();
    expect(rows).toEqual([{ id: 1, city: 'HN' }, { id: 2, city: 'SG' }]);
  });
});
