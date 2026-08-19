import { describe, it, expect } from 'vitest';
import { StreamAggregateOperator } from '../../../src/execution/operators/stream-aggregate.js';
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

function sumDef(colIdx, resultType = 'FLOAT64') {
  return {
    name: 'SUM',
    resultType,
    createAccumulator: () => ({ val: 0, add(v) { if (v !== null && v !== undefined) this.val += v; }, result() { return this.val; } }),
    extractValue: (chunk, row) => chunk.columns[colIdx].get(row),
  };
}

function countDef() {
  return {
    name: 'COUNT_STAR',
    resultType: 'INT32',
    createAccumulator: () => ({ count: 0, add() { this.count++; }, result() { return this.count; } }),
    extractValue: () => 1,
  };
}

function minDef(colIdx, resultType = 'FLOAT64') {
  return {
    name: 'MIN',
    resultType,
    createAccumulator: () => ({
      val: null,
      add(v) { if (v !== null && v !== undefined && (this.val === null || v < this.val)) this.val = v; },
      result() { return this.val; },
    }),
    extractValue: (chunk, row) => chunk.columns[colIdx].get(row),
  };
}

function maxDef(colIdx, resultType = 'FLOAT64') {
  return {
    name: 'MAX',
    resultType,
    createAccumulator: () => ({
      val: null,
      add(v) { if (v !== null && v !== undefined && (this.val === null || v > this.val)) this.val = v; },
      result() { return this.val; },
    }),
    extractValue: (chunk, row) => chunk.columns[colIdx].get(row),
  };
}

function avgDef(colIdx) {
  return {
    name: 'AVG',
    resultType: 'FLOAT64',
    createAccumulator: () => ({
      sum: 0, count: 0,
      add(v) { if (v !== null && v !== undefined) { this.sum += v; this.count++; } },
      result() { return this.count === 0 ? null : this.sum / this.count; },
    }),
    extractValue: (chunk, row) => chunk.columns[colIdx].get(row),
  };
}

describe('StreamAggregateOperator', () => {
  describe('group key separation', () => {
    it('keeps adjacent multi-column groups apart when a key contains a separator character', async () => {
      const op = new StreamAggregateOperator(
        [
          (chunk, row) => chunk.columns[0].get(row),
          (chunk, row) => chunk.columns[1].get(row),
        ],
        ['VARCHAR', 'VARCHAR'],
        [sumDef(2)]
      );
      const chunks = [makeChunk([
        { type: 'VARCHAR', values: ['a|b', 'a'] },
        { type: 'VARCHAR', values: ['c', 'b|c'] },
        { type: 'FLOAT64', values: [1, 10] },
      ])];

      const rows = (await op.execute(chunks))[0].toRows();

      expect(rows.length).toBe(2);
      expect(rows.map(r => r[2]).sort((x, y) => x - y)).toEqual([1, 10]);
    });
  });

  describe('ungrouped aggregation', () => {
    it('computes SUM over all rows', async () => {
      const op = new StreamAggregateOperator([], [], [sumDef(0)]);
      const chunks = [makeChunk([{ type: 'FLOAT64', values: [10, 20, 30] }])];

      const result = await op.execute(chunks);
      const rows = result[0].toRows();

      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe(60);
    });

    it('computes COUNT(*) over all rows', async () => {
      const op = new StreamAggregateOperator([], [], [countDef()]);
      const chunks = [makeChunk([{ type: 'INT32', values: [1, 2, 3, 4] }])];

      const result = await op.execute(chunks);

      expect(result[0].toRows()[0][0]).toBe(4);
    });

    it('computes MIN and MAX together', async () => {
      const op = new StreamAggregateOperator([], [], [minDef(0), maxDef(0)]);
      const chunks = [makeChunk([{ type: 'FLOAT64', values: [5, 1, 9, 3] }])];

      const result = await op.execute(chunks);
      const row = result[0].toRows()[0];

      expect(row[0]).toBe(1);
      expect(row[1]).toBe(9);
    });

    it('computes AVG correctly', async () => {
      const op = new StreamAggregateOperator([], [], [avgDef(0)]);
      const chunks = [makeChunk([{ type: 'FLOAT64', values: [10, 20, 30] }])];

      const result = await op.execute(chunks);

      expect(result[0].toRows()[0][0]).toBe(20);
    });

    it('returns identity values for empty input', async () => {
      const op = new StreamAggregateOperator([], [], [sumDef(0), countDef()]);
      const result = await op.execute([]);

      expect(result[0].toRows()[0][0]).toBe(0);
      expect(result[0].toRows()[0][1]).toBe(0);
    });

    it('handles multiple aggregates on different columns', async () => {
      const op = new StreamAggregateOperator([], [], [sumDef(0), sumDef(1)]);
      const chunks = [makeChunk([
        { type: 'FLOAT64', values: [1, 2, 3] },
        { type: 'FLOAT64', values: [10, 20, 30] },
      ])];

      const result = await op.execute(chunks);
      const row = result[0].toRows()[0];

      expect(row[0]).toBe(6);
      expect(row[1]).toBe(60);
    });
  });

  describe('grouped aggregation', () => {
    it('groups by single key and aggregates per group', async () => {
      const groupBy = [(chunk, row) => chunk.columns[0].get(row)];
      const op = new StreamAggregateOperator(groupBy, ['VARCHAR'], [sumDef(1)]);
      const chunks = [makeChunk([
        { type: 'VARCHAR', values: ['a', 'a', 'b', 'b', 'b'] },
        { type: 'FLOAT64', values: [10, 20, 1, 2, 3] },
      ])];

      const result = await op.execute(chunks);
      const rows = result[0].toRows();

      expect(rows.length).toBe(2);
      expect(rows[0][0]).toBe('a');
      expect(rows[0][1]).toBe(30);
      expect(rows[1][0]).toBe('b');
      expect(rows[1][1]).toBe(6);
    });

    it('handles single-row groups', async () => {
      const groupBy = [(chunk, row) => chunk.columns[0].get(row)];
      const op = new StreamAggregateOperator(groupBy, ['INT32'], [countDef()]);
      const chunks = [makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
      ])];

      const result = await op.execute(chunks);
      const rows = result[0].toRows();

      expect(rows.length).toBe(3);
      for (const row of rows) expect(row[1]).toBe(1);
    });

    it('groups with multiple group-by keys', async () => {
      const groupBy = [
        (chunk, row) => chunk.columns[0].get(row),
        (chunk, row) => chunk.columns[1].get(row),
      ];
      const op = new StreamAggregateOperator(groupBy, ['VARCHAR', 'INT32'], [sumDef(2)]);
      const chunks = [makeChunk([
        { type: 'VARCHAR', values: ['a', 'a', 'a', 'b'] },
        { type: 'INT32', values: [1, 1, 2, 1] },
        { type: 'FLOAT64', values: [10, 20, 30, 40] },
      ])];

      const result = await op.execute(chunks);
      const rows = result[0].toRows();

      expect(rows.length).toBe(3);
      expect(rows[0]).toEqual(['a', 1, 30]);
      expect(rows[1]).toEqual(['a', 2, 30]);
      expect(rows[2]).toEqual(['b', 1, 40]);
    });

    it('handles group with multiple aggregates', async () => {
      const groupBy = [(chunk, row) => chunk.columns[0].get(row)];
      const op = new StreamAggregateOperator(groupBy, ['VARCHAR'], [sumDef(1), countDef(), minDef(1), maxDef(1)]);
      const chunks = [makeChunk([
        { type: 'VARCHAR', values: ['x', 'x', 'x'] },
        { type: 'FLOAT64', values: [5, 15, 10] },
      ])];

      const result = await op.execute(chunks);
      const row = result[0].toRows()[0];

      expect(row[0]).toBe('x');
      expect(row[1]).toBe(30);
      expect(row[2]).toBe(3);
      expect(row[3]).toBe(5);
      expect(row[4]).toBe(15);
    });
  });

  describe('multi-chunk input', () => {
    it('aggregates across chunk boundaries within same group', async () => {
      const groupBy = [(chunk, row) => chunk.columns[0].get(row)];
      const op = new StreamAggregateOperator(groupBy, ['VARCHAR'], [sumDef(1)]);
      const chunks = [
        makeChunk([{ type: 'VARCHAR', values: ['a', 'a'] }, { type: 'FLOAT64', values: [10, 20] }]),
        makeChunk([{ type: 'VARCHAR', values: ['a', 'b'] }, { type: 'FLOAT64', values: [30, 5] }]),
      ];

      const result = await op.execute(chunks);
      const rows = result[0].toRows();

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual(['a', 60]);
      expect(rows[1]).toEqual(['b', 5]);
    });
  });

  describe('null handling in aggregation', () => {
    it('skips null values in SUM', async () => {
      const op = new StreamAggregateOperator([], [], [sumDef(0)]);
      const chunks = [makeChunk([{ type: 'FLOAT64', values: [10, null, 30] }])];

      const result = await op.execute(chunks);

      expect(result[0].toRows()[0][0]).toBe(40);
    });

    it('skips null values in MIN/MAX', async () => {
      const op = new StreamAggregateOperator([], [], [minDef(0), maxDef(0)]);
      const chunks = [makeChunk([{ type: 'FLOAT64', values: [null, 5, null, 3, null] }])];

      const result = await op.execute(chunks);
      const row = result[0].toRows()[0];

      expect(row[0]).toBe(3);
      expect(row[1]).toBe(5);
    });
  });

  describe('selection vector', () => {
    it('respects active rows via selection vector', async () => {
      const op = new StreamAggregateOperator([], [], [sumDef(0), countDef()]);
      const chunk = makeChunk([{ type: 'FLOAT64', values: [10, 20, 30, 40, 50] }]);
      chunk.setSelectionVector(new Uint32Array([1, 3]), 2);

      const result = await op.execute([chunk]);
      const row = result[0].toRows()[0];

      expect(row[0]).toBe(60);
      expect(row[1]).toBe(2);
    });
  });
});
