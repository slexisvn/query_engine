import { describe, it, expect } from 'vitest';
import { ProjectionOperator } from '../../../src/execution/operators/projection.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

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

function colRefExpr(columnIndex, dataType = 'INT32') {
  return { kind: BoundExprKind.COLUMN_REF, columnIndex, dataType, tableAlias: '', columnName: '' };
}

describe('ProjectionOperator', () => {
  describe('evaluator-based projection', () => {
    it('computes new columns from evaluator functions', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [10, 20, 30] },
        { type: 'INT32', values: [1, 2, 3] },
      ]);
      const evaluators = [(c, r) => c.columns[0].get(r) + c.columns[1].get(r)];
      const op = new ProjectionOperator([null], evaluators, ['INT32']);

      const result = await op.process(chunk);

      expect(result.size).toBe(3);
      expect(result.columns[0].get(0)).toBe(11);
      expect(result.columns[0].get(1)).toBe(22);
      expect(result.columns[0].get(2)).toBe(33);
    });

    it('projects multiple expressions simultaneously', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [5, 10] },
        { type: 'INT32', values: [2, 3] },
      ]);
      const evaluators = [
        (c, r) => c.columns[0].get(r) * c.columns[1].get(r),
        (c, r) => c.columns[0].get(r) - c.columns[1].get(r),
      ];
      const op = new ProjectionOperator([null, null], evaluators, ['INT32', 'INT32']);

      const result = await op.process(chunk);

      expect(result.columns[0].get(0)).toBe(10);
      expect(result.columns[0].get(1)).toBe(30);
      expect(result.columns[1].get(0)).toBe(3);
      expect(result.columns[1].get(1)).toBe(7);
    });

    it('handles string concatenation', async () => {
      const chunk = makeChunk([
        { type: 'VARCHAR', values: ['hello', 'world'] },
        { type: 'VARCHAR', values: [' world', ' peace'] },
      ]);
      const evaluators = [(c, r) => c.columns[0].get(r) + c.columns[1].get(r)];
      const op = new ProjectionOperator([null], evaluators, ['VARCHAR']);

      const result = await op.process(chunk);

      expect(result.columns[0].get(0)).toBe('hello world');
      expect(result.columns[0].get(1)).toBe('world peace');
    });
  });

  describe('column reference passthrough', () => {
    it('reuses source column directly for COLUMN_REF expressions', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]);
      const expr = colRefExpr(1, 'VARCHAR');
      const evaluators = [(c, r) => c.columns[1].get(r)];
      const op = new ProjectionOperator([expr], evaluators, ['VARCHAR']);

      const result = await op.process(chunk);

      expect(result.columns[0]).toBe(chunk.columns[1]);
    });

    it('falls back to evaluator when chunk has selectionVector', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [10, 20, 30, 40] },
      ]);
      chunk.setSelectionVector(new Uint32Array([1, 3]), 2);

      const expr = colRefExpr(0);
      const evaluators = [(c, r) => c.columns[0].get(r)];
      const op = new ProjectionOperator([expr], evaluators, ['INT32']);

      const result = await op.process(chunk);

      expect(result.size).toBe(2);
      expect(result.columns[0].get(0)).toBe(20);
      expect(result.columns[0].get(1)).toBe(40);
    });
  });

  describe('column mapping', () => {
    it('resolves column ref via mapping', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [100, 200] },
        { type: 'VARCHAR', values: ['x', 'y'] },
      ]);
      const mapping = new Map([['T.NAME', 1]]);
      const expr = { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: 'NAME', columnIndex: -1, dataType: 'VARCHAR' };
      const evaluators = [(c, r) => c.columns[1].get(r)];
      const op = new ProjectionOperator([expr], evaluators, ['VARCHAR'], mapping);

      const result = await op.process(chunk);

      expect(result.columns[0]).toBe(chunk.columns[1]);
    });
  });

  describe('selection vector handling', () => {
    it('evaluates only active rows through selection vector', async () => {
      const chunk = makeChunk([
        { type: 'INT32', values: [1, 2, 3, 4, 5] },
      ]);
      chunk.setSelectionVector(new Uint32Array([0, 2, 4]), 3);

      const evaluators = [(c, r) => c.columns[0].get(r) * 10];
      const op = new ProjectionOperator([null], evaluators, ['INT32']);

      const result = await op.process(chunk);

      expect(result.size).toBe(3);
      expect(result.columns[0].get(0)).toBe(10);
      expect(result.columns[0].get(1)).toBe(30);
      expect(result.columns[0].get(2)).toBe(50);
    });
  });

  describe('empty chunk', () => {
    it('returns empty chunk for empty input', async () => {
      const chunk = makeChunk([{ type: 'INT32', values: [] }]);
      const evaluators = [(c, r) => c.columns[0].get(r)];
      const op = new ProjectionOperator([null], evaluators, ['INT32']);

      const result = await op.process(chunk);

      expect(result.size).toBe(0);
    });
  });

  describe('bigint conversion', () => {
    it('converts bigint to number when target type is not INT64', async () => {
      const chunk = makeChunk([{ type: 'INT64', values: [10n, 20n] }]);
      const evaluators = [(c, r) => c.columns[0].get(r)];
      const op = new ProjectionOperator([null], evaluators, ['INT32']);

      const result = await op.process(chunk);

      expect(typeof result.columns[0].get(0)).toBe('number');
      expect(result.columns[0].get(0)).toBe(10);
    });

    it('preserves bigint when target type is INT64', async () => {
      const chunk = makeChunk([{ type: 'INT64', values: [10n, 20n] }]);
      const evaluators = [(c, r) => c.columns[0].get(r)];
      const op = new ProjectionOperator([null], evaluators, ['INT64']);

      const result = await op.process(chunk);

      expect(typeof result.columns[0].get(0)).toBe('bigint');
      expect(result.columns[0].get(0)).toBe(10n);
    });
  });
});

describe('ProjectionOperator columnar tier', () => {
  function numericChunk(values) {
    const col = new Column('FLOAT64', Math.max(values.length, 1));
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return new DataChunk([col], values.length);
  }

  const mapping = new Map([['T.VAL', 0], ['VAL', 0]]);

  function colRef() {
    return { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: 'VAL' };
  }

  function arithmetic() {
    return {
      kind: BoundExprKind.BINARY,
      op: '*',
      left: colRef(),
      right: { kind: BoundExprKind.LITERAL, value: 3 },
    };
  }

  it('compiles a columnar projection for an eligible arithmetic expression', () => {
    const op = new ProjectionOperator([arithmetic()], [() => null], ['FLOAT64'], mapping, null);
    expect(op.columnarProjections[0]).not.toBeNull();
  });

  it('leaves no columnar projection for an ineligible expression', () => {
    const op = new ProjectionOperator([colRef()], [() => null], ['FLOAT64'], mapping, null);
    expect(op.columnarProjections[0]).toBeNull();
  });

  it('produces the arithmetic result without calling the scalar evaluator', async () => {
    let scalarCalls = 0;
    const evaluator = (chunk, row) => { scalarCalls++; return chunk.columns[0].get(row) * 3; };
    const op = new ProjectionOperator([arithmetic()], [evaluator], ['FLOAT64'], mapping, null);

    const result = await op.process(numericChunk([1, 2, 3]));

    expect([result.getValue(0, 0), result.getValue(1, 0), result.getValue(2, 0)]).toEqual([3, 6, 9]);
    expect(scalarCalls).toBe(0);
  });

  it('falls back to the scalar evaluator when the columnar tier declines', async () => {
    const modulo = {
      kind: BoundExprKind.BINARY,
      op: '%',
      left: colRef(),
      right: { kind: BoundExprKind.LITERAL, value: 2 },
    };
    let scalarCalls = 0;
    const evaluator = (chunk, row) => { scalarCalls++; return chunk.columns[0].get(row) / 2; };
    const op = new ProjectionOperator([modulo], [evaluator], ['FLOAT64'], mapping, null);

    const result = await op.process(numericChunk([2, 4, 6]));

    expect(scalarCalls).toBe(3);
    expect([0, 1, 2].map(i => result.getValue(i, 0))).toEqual([1, 2, 3]);
  });

  it('matches the scalar evaluator on a nullable input', async () => {
    const evaluator = (chunk, row) => {
      const v = chunk.columns[0].get(row);
      return v === null ? null : v * 3;
    };
    const columnar = new ProjectionOperator([arithmetic()], [evaluator], ['FLOAT64'], mapping, null);
    const scalar = new ProjectionOperator([colRef()], [evaluator], ['FLOAT64'], mapping, null);

    const fromColumnar = await columnar.process(numericChunk([1, null, 3]));
    const fromScalar = await scalar.process(numericChunk([1, null, 3]));

    expect([0, 1, 2].map(i => fromColumnar.getValue(i, 0))).toEqual([3, null, 9]);
    expect([0, 1, 2].map(i => fromScalar.getValue(i, 0))).toEqual([1, null, 3]);
  });
});
