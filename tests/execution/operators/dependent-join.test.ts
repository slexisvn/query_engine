import { describe, it, expect } from 'vitest';
import { DependentJoinOperator } from '../../../src/execution/operators/dependent-join.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';

function makeChunk(colDefs) {
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, colDefs[0].values.length);
}

const schema = [
  { name: 'id', dataType: 'INT32', tableAlias: 'a' },
  { name: 'val', dataType: 'INT32', tableAlias: 'a' },
];

describe('DependentJoinOperator', () => {
  describe('EXISTS', () => {
    it('keeps outer row when subquery returns results', async () => {
      const op = new DependentJoinOperator('EXISTS', schema);
      const subChunk = makeChunk([{ type: 'INT32', values: [10] }]);
      await op.processOuterRow([1, 100], [subChunk]);

      const result = await op.finalize();

      expect(result.length).toBe(1);
      expect(result[0].size).toBe(1);
      expect(result[0].getValue(0, 0)).toBe(1);
      expect(result[0].getValue(0, 1)).toBe(100);
    });

    it('discards outer row when subquery returns empty', async () => {
      const op = new DependentJoinOperator('EXISTS', schema);
      await op.processOuterRow([1, 100], []);

      const result = await op.finalize();

      expect(result.length).toBe(0);
    });

    it('processes multiple outer rows correctly', async () => {
      const op = new DependentJoinOperator('EXISTS', schema);
      const subChunk = makeChunk([{ type: 'INT32', values: [10] }]);
      await op.processOuterRow([1, 100], [subChunk]);
      await op.processOuterRow([2, 200], []);
      await op.processOuterRow([3, 300], [subChunk]);

      const result = await op.finalize();

      expect(result[0].size).toBe(2);
      expect(result[0].getValue(0, 0)).toBe(1);
      expect(result[0].getValue(1, 0)).toBe(3);
    });
  });

  describe('NOT_EXISTS', () => {
    it('keeps outer row when subquery returns empty', async () => {
      const op = new DependentJoinOperator('NOT_EXISTS', schema);
      await op.processOuterRow([1, 100], []);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
      expect(result[0].getValue(0, 0)).toBe(1);
    });

    it('discards outer row when subquery returns results', async () => {
      const op = new DependentJoinOperator('NOT_EXISTS', schema);
      const subChunk = makeChunk([{ type: 'INT32', values: [10] }]);
      await op.processOuterRow([1, 100], [subChunk]);

      const result = await op.finalize();

      expect(result.length).toBe(0);
    });
  });

  describe('SCALAR', () => {
    it('appends scalar value from subquery to outer row', async () => {
      const op = new DependentJoinOperator('SCALAR', schema);
      const subChunk = makeChunk([{ type: 'FLOAT64', values: [42.5] }]);
      await op.processOuterRow([1, 100], [subChunk]);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
      expect(result[0].getValue(0, 0)).toBe(1);
      expect(result[0].getValue(0, 1)).toBe(100);
      expect(result[0].getValue(0, 2)).toBe(42.5);
    });

    it('appends null when subquery returns empty', async () => {
      const op = new DependentJoinOperator('SCALAR', schema);
      await op.processOuterRow([1, 100], []);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
      expect(result[0].getValue(0, 2)).toBeNull();
    });

    it('takes first row from subquery when multiple returned', async () => {
      const op = new DependentJoinOperator('SCALAR', schema);
      const subChunk = makeChunk([{ type: 'FLOAT64', values: [10, 20, 30] }]);
      await op.processOuterRow([1, 100], [subChunk]);

      const result = await op.finalize();

      expect(result[0].getValue(0, 2)).toBe(10);
    });

    it('extends schema with _scalar column', () => {
      const op = new DependentJoinOperator('SCALAR', schema);

      expect(op.resultSchema.length).toBe(3);
      expect(op.resultSchema[2].name).toBe('_scalar');
      expect(op.resultSchema[2].dataType).toBe('FLOAT64');
    });
  });

  describe('IN', () => {
    it('keeps outer row when subquery returns results (same as EXISTS)', async () => {
      const op = new DependentJoinOperator('IN', schema);
      const subChunk = makeChunk([{ type: 'INT32', values: [1] }]);
      await op.processOuterRow([1, 100], [subChunk]);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
    });

    it('discards outer row when subquery returns empty', async () => {
      const op = new DependentJoinOperator('IN', schema);
      await op.processOuterRow([1, 100], []);

      const result = await op.finalize();

      expect(result.length).toBe(0);
    });
  });

  describe('NOT_IN', () => {
    it('keeps outer row when subquery returns empty (same as NOT_EXISTS)', async () => {
      const op = new DependentJoinOperator('NOT_IN', schema);
      await op.processOuterRow([1, 100], []);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
    });

    it('discards outer row when subquery returns results', async () => {
      const op = new DependentJoinOperator('NOT_IN', schema);
      const subChunk = makeChunk([{ type: 'INT32', values: [1] }]);
      await op.processOuterRow([1, 100], [subChunk]);

      const result = await op.finalize();

      expect(result.length).toBe(0);
    });
  });

  describe('unknown subquery type', () => {
    it('always keeps outer row', async () => {
      const op = new DependentJoinOperator('UNKNOWN', schema);
      await op.processOuterRow([1, 100], []);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
    });
  });

  describe('finalize output format', () => {
    it('returns empty array when no rows collected', async () => {
      const op = new DependentJoinOperator('EXISTS', schema);

      const result = await op.finalize();

      expect(result).toEqual([]);
    });

    it('produces DataChunk with correct column count', async () => {
      const op = new DependentJoinOperator('EXISTS', schema);
      const subChunk = makeChunk([{ type: 'INT32', values: [10] }]);
      await op.processOuterRow([1, 100], [subChunk]);

      const result = await op.finalize();

      expect(result[0].columns.length).toBe(2);
    });

    it('handles multiple subquery chunks per outer row', async () => {
      const op = new DependentJoinOperator('EXISTS', schema);
      const chunk1 = makeChunk([{ type: 'INT32', values: [10] }]);
      const chunk2 = makeChunk([{ type: 'INT32', values: [20] }]);
      await op.processOuterRow([1, 100], [chunk1, chunk2]);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
    });
  });

  describe('selection vector in subquery chunks', () => {
    it('reads values through activeRowIndex', async () => {
      const op = new DependentJoinOperator('EXISTS', schema);
      const col = new Column('INT32', 4);
      col.set(0, 10); col.set(1, 20); col.set(2, 30); col.set(3, 40);
      col.length = 4;
      const chunk = new DataChunk([col], 2);
      chunk.setSelectionVector(new Uint32Array([1, 3]), 2);
      await op.processOuterRow([1, 100], [chunk]);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
    });
  });
});
