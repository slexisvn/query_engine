import { describe, it, expect } from 'vitest';
import {
  HashAggregateOperator,
  SumAccumulator,
  CountAccumulator,
  CountStarAccumulator,
  AvgAccumulator,
  MinAccumulator,
  MaxAccumulator,
  CountDistinctAccumulator,
  getAccumulatorFactory,
} from '../../../src/execution/operators/hash-aggregate.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function aggDef(name, extractIdx, resultType = 'FLOAT64') {
  const factory = getAccumulatorFactory(name);
  return {
    name,
    resultType,
    extractValue: (chunk, row) => chunk.columns[extractIdx].get(row),
    createAccumulator: factory,
  };
}

function countStarDef() {
  return {
    name: 'COUNT_STAR',
    resultType: 'INT32',
    extractValue: () => 1,
    createAccumulator: getAccumulatorFactory('COUNT_STAR'),
  };
}

describe('Accumulators', () => {
  describe('SumAccumulator', () => {
    it('sums numeric values', () => {
      const acc = new SumAccumulator();
      acc.add(10); acc.add(20); acc.add(30);
      expect(acc.result()).toBe(60);
    });

    it('returns null when no values added', () => {
      const acc = new SumAccumulator();
      expect(acc.result()).toBeNull();
    });

    it('skips null values', () => {
      const acc = new SumAccumulator();
      acc.add(10); acc.add(null); acc.add(20);
      expect(acc.result()).toBe(30);
    });
  });

  describe('CountAccumulator', () => {
    it('counts non-null values', () => {
      const acc = new CountAccumulator();
      acc.add(1); acc.add(null); acc.add(3);
      expect(acc.result()).toBe(2);
    });

    it('returns 0 when no values added', () => {
      const acc = new CountAccumulator();
      expect(acc.result()).toBe(0);
    });
  });

  describe('CountStarAccumulator', () => {
    it('counts all calls including nulls', () => {
      const acc = new CountStarAccumulator();
      acc.add(1); acc.add(null); acc.add(undefined);
      expect(acc.result()).toBe(3);
    });
  });

  describe('AvgAccumulator', () => {
    it('computes average of numeric values', () => {
      const acc = new AvgAccumulator();
      acc.add(10); acc.add(20); acc.add(30);
      expect(acc.result()).toBe(20);
    });

    it('returns null when no values', () => {
      const acc = new AvgAccumulator();
      expect(acc.result()).toBeNull();
    });

    it('skips nulls in average', () => {
      const acc = new AvgAccumulator();
      acc.add(10); acc.add(null); acc.add(30);
      expect(acc.result()).toBe(20);
    });
  });

  describe('MinAccumulator', () => {
    it('finds minimum value', () => {
      const acc = new MinAccumulator();
      acc.add(30); acc.add(10); acc.add(20);
      expect(acc.result()).toBe(10);
    });

    it('returns null when no values', () => {
      const acc = new MinAccumulator();
      expect(acc.result()).toBeNull();
    });

    it('skips nulls', () => {
      const acc = new MinAccumulator();
      acc.add(null); acc.add(5); acc.add(null);
      expect(acc.result()).toBe(5);
    });
  });

  describe('MaxAccumulator', () => {
    it('finds maximum value', () => {
      const acc = new MaxAccumulator();
      acc.add(10); acc.add(30); acc.add(20);
      expect(acc.result()).toBe(30);
    });

    it('returns null when no values', () => {
      const acc = new MaxAccumulator();
      expect(acc.result()).toBeNull();
    });
  });

  describe('CountDistinctAccumulator', () => {
    it('counts distinct non-null values', () => {
      const acc = new CountDistinctAccumulator();
      acc.add(1); acc.add(2); acc.add(1); acc.add(3); acc.add(2);
      expect(acc.result()).toBe(3);
    });

    it('ignores nulls', () => {
      const acc = new CountDistinctAccumulator();
      acc.add(1); acc.add(null); acc.add(1);
      expect(acc.result()).toBe(1);
    });
  });

  describe('getAccumulatorFactory', () => {
    it('returns CountDistinctAccumulator for COUNT with distinct flag', () => {
      const factory = getAccumulatorFactory('COUNT', true);
      const acc = factory();
      expect(acc).toBeInstanceOf(CountDistinctAccumulator);
    });

    it('throws for unknown aggregate', () => {
      expect(() => getAccumulatorFactory('UNKNOWN')).toThrow('Unknown aggregate');
    });
  });
});

describe('HashAggregateOperator', () => {
  describe('ungrouped aggregation', () => {
    it('computes SUM across all rows', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('SUM', 0)]);
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [10, 20, 30] }]));

      const result = await op.finalize();

      expect(result.length).toBe(1);
      expect(result[0].size).toBe(1);
      expect(result[0].getValue(0, 0)).toBe(60);
    });

    it('computes COUNT across all rows', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('COUNT', 0, 'INT32')]);
      await op.consume(makeChunk([{ type: 'INT32', values: [1, null, 3] }]));

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(2);
    });

    it('returns default accumulator result when no input', async () => {
      const op = new HashAggregateOperator([], [], [countStarDef()]);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
      expect(result[0].getValue(0, 0)).toBe(0);
    });

    it('handles multiple aggregates at once', async () => {
      const op = new HashAggregateOperator([], [], [
        aggDef('SUM', 0),
        aggDef('MIN', 0),
        aggDef('MAX', 0),
      ]);
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [5, 15, 10] }]));

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(30);
      expect(result[0].getValue(0, 1)).toBe(5);
      expect(result[0].getValue(0, 2)).toBe(15);
    });
  });

  describe('grouped aggregation', () => {
    it('groups by single column and aggregates', async () => {
      const op = new HashAggregateOperator(
        [(chunk, row) => chunk.columns[0].get(row)],
        ['VARCHAR'],
        [aggDef('SUM', 1)]
      );
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a', 'b', 'a', 'b', 'a'] },
        { type: 'FLOAT64', values: [10, 20, 30, 40, 50] },
      ]));

      const result = await op.finalize();

      expect(result[0].size).toBe(2);
      const rows = result[0].toRows();
      const map = new Map(rows.map(r => [r[0], r[1]]));
      expect(map.get('a')).toBe(90);
      expect(map.get('b')).toBe(60);
    });

    it('groups by multiple columns', async () => {
      const op = new HashAggregateOperator(
        [
          (chunk, row) => chunk.columns[0].get(row),
          (chunk, row) => chunk.columns[1].get(row),
        ],
        ['VARCHAR', 'INT32'],
        [countStarDef()]
      );
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a', 'a', 'b', 'a'] },
        { type: 'INT32', values: [1, 2, 1, 1] },
        { type: 'FLOAT64', values: [0, 0, 0, 0] },
      ]));

      const result = await op.finalize();

      expect(result[0].size).toBe(3);
      const rows = result[0].toRows();
      const map = new Map(rows.map(r => [`${r[0]}|${r[1]}`, r[2]]));
      expect(map.get('a|1')).toBe(2);
      expect(map.get('a|2')).toBe(1);
      expect(map.get('b|1')).toBe(1);
    });

    it('returns empty when no input and has group-by', async () => {
      const op = new HashAggregateOperator(
        [(chunk, row) => chunk.columns[0].get(row)],
        ['INT32'],
        [countStarDef()]
      );

      const result = await op.finalize();

      expect(result).toEqual([]);
    });
  });

  describe('multi-chunk consumption', () => {
    it('accumulates across multiple consume calls', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('SUM', 0)]);
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [10, 20] }]));
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [30, 40] }]));

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(100);
    });

    it('merges groups across chunks', async () => {
      const op = new HashAggregateOperator(
        [(chunk, row) => chunk.columns[0].get(row)],
        ['VARCHAR'],
        [aggDef('SUM', 1)]
      );
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a', 'b'] },
        { type: 'FLOAT64', values: [10, 20] },
      ]));
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a', 'c'] },
        { type: 'FLOAT64', values: [30, 40] },
      ]));

      const result = await op.finalize();

      const rows = result[0].toRows();
      const map = new Map(rows.map(r => [r[0], r[1]]));
      expect(map.get('a')).toBe(40);
      expect(map.get('b')).toBe(20);
      expect(map.get('c')).toBe(40);
    });
  });

  describe('selection vector input', () => {
    it('respects selection vector when consuming', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('SUM', 0)]);
      const col = new Column('FLOAT64', 5);
      [10, 20, 30, 40, 50].forEach((v, i) => col.set(i, v));
      col.length = 5;
      const chunk = new DataChunk([col], 3);
      chunk.setSelectionVector(new Uint32Array([0, 2, 4]), 3);
      await op.consume(chunk);

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(90);
    });
  });

  describe('AVG aggregation', () => {
    it('computes correct average', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('AVG', 0)]);
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [10, 20, 30] }]));

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(20);
    });
  });
});
