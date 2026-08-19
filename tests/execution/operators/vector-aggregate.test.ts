import { describe, it, expect } from 'vitest';
import { createVectorAggregator } from '../../../src/execution/operators/vector-aggregate.js';
import { instantiateFragment, StageKind } from '../../../src/execution/fragment-spec.js';
import { Column } from '../../../src/storage/column.js';
import { DictionaryColumn } from '../../../src/storage/dictionary-column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { DataType } from '../../../src/storage/data-type.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { Config } from '../../../src/config.js';

const ALIAS = 'T';
const colRef = (name, dataType) => ({ kind: BoundExprKind.COLUMN_REF, columnName: name, tableAlias: ALIAS, dataType });
const agg = (name, arg = null, distinct = false) => ({ name, distinct, args: arg ? [arg] : [] });

const INT_SCHEMA = [
  { name: 'k', dataType: DataType.INT32, tableAlias: ALIAS },
  { name: 'n', dataType: DataType.FLOAT64, tableAlias: ALIAS },
];
const DICT_SCHEMA = [
  { name: 'g', dataType: DataType.VARCHAR, tableAlias: ALIAS },
  { name: 'n', dataType: DataType.INT32, tableAlias: ALIAS },
];

function specOf({ schema, stages = [], groupBy, aggregates }) {
  return { baseSchema: schema, stages, groupBy, aggregates };
}

function chunkFrom(schema, rows) {
  const cols = schema.map(s => s.dataType === DataType.VARCHAR
    ? new DictionaryColumn(Math.max(1, rows.length))
    : new Column(s.dataType, Math.max(1, rows.length)));
  for (const row of rows) row.forEach((v, i) => cols[i].append(v));
  return new DataChunk(cols, rows.length);
}

function intSpec(aggregates) {
  return specOf({ schema: INT_SCHEMA, groupBy: [colRef('k', DataType.INT32)], aggregates });
}

const ALL_AGGS = [
  agg('SUM', colRef('n', DataType.FLOAT64)),
  agg('AVG', colRef('n', DataType.FLOAT64)),
  agg('MIN', colRef('n', DataType.FLOAT64)),
  agg('MAX', colRef('n', DataType.FLOAT64)),
  agg('COUNT', colRef('n', DataType.FLOAT64)),
  agg('COUNT_STAR'),
];

async function finalizeRows(aggregateOp) {
  const chunks = await aggregateOp.finalize();
  const rows = [];
  for (const chunk of chunks) for (const row of chunk.toRows()) rows.push(row);
  return rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

describe('createVectorAggregator eligibility', () => {
  it('accepts INT32/DATE/VARCHAR single-column group keys with plain aggregate args', () => {
    expect(createVectorAggregator(intSpec(ALL_AGGS))).not.toBeNull();
    expect(createVectorAggregator(specOf({
      schema: DICT_SCHEMA,
      groupBy: [colRef('g', DataType.VARCHAR)],
      aggregates: [agg('COUNT_STAR')],
    }))).not.toBeNull();
  });

  it('rejects project stages, multi-key groups, distinct, expressions and unsupported types', () => {
    expect(createVectorAggregator(specOf({
      schema: INT_SCHEMA,
      stages: [{ kind: StageKind.PROJECT, expressions: [colRef('k', DataType.INT32)] }],
      groupBy: [colRef('k', DataType.INT32)],
      aggregates: [agg('COUNT_STAR')],
    }))).toBeNull();

    expect(createVectorAggregator(specOf({
      schema: INT_SCHEMA,
      groupBy: [colRef('k', DataType.INT32), colRef('n', DataType.FLOAT64)],
      aggregates: [agg('COUNT_STAR')],
    }))).toBeNull();

    expect(createVectorAggregator(intSpec([agg('COUNT', colRef('n', DataType.FLOAT64), true)]))).toBeNull();

    expect(createVectorAggregator(intSpec([agg('SUM', {
      kind: BoundExprKind.BINARY, op: '*',
      left: colRef('n', DataType.FLOAT64),
      right: { kind: BoundExprKind.LITERAL, value: 2 },
    })]))).toBeNull();

    expect(createVectorAggregator(specOf({
      schema: [{ name: 'k', dataType: DataType.FLOAT64, tableAlias: ALIAS }, INT_SCHEMA[1]],
      groupBy: [colRef('k', DataType.FLOAT64)],
      aggregates: [agg('COUNT_STAR')],
    }))).toBeNull();

    expect(createVectorAggregator(intSpec([agg('NO_SUCH', colRef('n', DataType.FLOAT64))]))).toBeNull();
  });

  it('accepts filter stages (selection vectors are handled per row)', () => {
    expect(createVectorAggregator(specOf({
      schema: INT_SCHEMA,
      stages: [{
        kind: StageKind.FILTER,
        condition: {
          kind: BoundExprKind.BINARY, op: '>',
          left: colRef('n', DataType.FLOAT64),
          right: { kind: BoundExprKind.LITERAL, value: 0 },
        },
      }],
      groupBy: [colRef('k', DataType.INT32)],
      aggregates: [agg('COUNT_STAR')],
    }))).not.toBeNull();
  });
});

describe('VectorGroupAggregator equivalence with HashAggregateOperator', () => {
  it('matches the hash path over random int-keyed data with nulls (all aggregate kinds)', async () => {
    const spec = intSpec(ALL_AGGS);
    const rows = [];
    for (let i = 0; i < 700; i++) {
      rows.push([
        i % 13 === 0 ? null : ((i * 31) % 50) - 25,
        i % 7 === 0 ? null : ((i * 17) % 200) - 100 + 0.5,
      ]);
    }
    const chunks = [chunkFrom(INT_SCHEMA, rows.slice(0, 250)), chunkFrom(INT_SCHEMA, rows.slice(250))];

    const vector = createVectorAggregator(spec);
    for (const chunk of chunks) expect(vector.consume(chunk)).toBe(true);

    const reference = instantiateFragment(spec).aggregate;
    for (const chunk of chunks) await reference.consume(chunk);

    const absorbed = instantiateFragment(spec).aggregate;
    for (const partition of vector.exportPartials(8)) absorbed.absorbPartials(partition);

    expect(await finalizeRows(absorbed)).toEqual(await finalizeRows(reference));
  });

  it('merges dictionary ids across chunks with different local dictionaries', async () => {
    const spec = specOf({
      schema: DICT_SCHEMA,
      groupBy: [colRef('g', DataType.VARCHAR)],
      aggregates: [agg('SUM', colRef('n', DataType.INT32)), agg('COUNT_STAR')],
    });
    const chunkA = chunkFrom(DICT_SCHEMA, [['x', 1], ['y', 2], [null, 3]]);
    const chunkB = chunkFrom(DICT_SCHEMA, [['z', 4], ['x', 5], [null, 6]]);

    const vector = createVectorAggregator(spec);
    expect(vector.consume(chunkA)).toBe(true);
    expect(vector.consume(chunkB)).toBe(true);

    const absorbed = instantiateFragment(spec).aggregate;
    for (const partition of vector.exportPartials(4)) absorbed.absorbPartials(partition);
    const rows = await finalizeRows(absorbed);

    const byKey = new Map(rows.map(r => [r[0], { s: r[1], cs: r[2] }]));
    expect(byKey.get('x')).toEqual({ s: 6, cs: 2 });
    expect(byKey.get('y')).toEqual({ s: 2, cs: 1 });
    expect(byKey.get('z')).toEqual({ s: 4, cs: 1 });
    expect(byKey.get(null)).toEqual({ s: 9, cs: 2 });
  });

  it('respects selection vectors from upstream filters', () => {
    const spec = intSpec([agg('COUNT_STAR')]);
    const chunk = chunkFrom(INT_SCHEMA, [[1, 1], [2, 2], [1, 3], [2, 4]]);
    chunk.setSelectionVector(new Uint32Array([0, 2]), 2);

    const vector = createVectorAggregator(spec);
    expect(vector.consume(chunk)).toBe(true);
    const partials = vector.exportPartials(1)[0];
    expect(partials).toEqual([{ key: 1, groupValues: [1], states: [2] }]);
  });

  it('refuses a chunk atomically when the dense range would exceed the limit', () => {
    const saved = Config.vectorGroupRange;
    Config.vectorGroupRange = 100;
    try {
      const spec = intSpec([agg('COUNT_STAR')]);
      const vector = createVectorAggregator(spec);
      expect(vector.consume(chunkFrom(INT_SCHEMA, [[1, 1], [2, 2]]))).toBe(true);
      expect(vector.groupCount).toBe(2);

      expect(vector.consume(chunkFrom(INT_SCHEMA, [[1000000, 1]]))).toBe(false);
      expect(vector.groupCount).toBe(2);
      expect(vector.exportPartials(1)[0].length).toBe(2);
    } finally {
      Config.vectorGroupRange = saved;
    }
  });

  it('grows slots and dense range across many groups including negatives', () => {
    const spec = intSpec([agg('COUNT_STAR')]);
    const vector = createVectorAggregator(spec);
    const rows = [];
    for (let i = 0; i < 5000; i++) rows.push([i - 2500, 1]);
    for (let off = 0; off < rows.length; off += 500) {
      expect(vector.consume(chunkFrom(INT_SCHEMA, rows.slice(off, off + 500)))).toBe(true);
    }
    expect(vector.groupCount).toBe(5000);
    const total = vector.exportPartials(8).flat().reduce((sum, p) => sum + p.states[0], 0);
    expect(total).toBe(5000);
  });

  it('clear() resets state so the aggregator can be reused after a spill flush', () => {
    const spec = intSpec([agg('SUM', colRef('n', DataType.FLOAT64))]);
    const vector = createVectorAggregator(spec);
    expect(vector.consume(chunkFrom(INT_SCHEMA, [[1, 10], [2, 20]]))).toBe(true);
    expect(vector.groupCount).toBe(2);
    vector.clear();
    expect(vector.groupCount).toBe(0);
    expect(vector.consume(chunkFrom(INT_SCHEMA, [[1, 5]]))).toBe(true);
    expect(vector.exportPartials(1)[0]).toEqual([{ key: 1, groupValues: [1], states: [5] }]);
  });
});
