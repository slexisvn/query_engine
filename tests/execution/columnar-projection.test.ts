import { describe, it, expect } from 'vitest';
import { compileColumnarProjection } from '../../src/execution/columnar-projection.js';
import { compileExpression } from '../../src/execution/expression-eval.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataType } from '../../src/storage/data-type.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function numericChunk(columns) {
  const size = columns[0].values.length;
  const cols = columns.map(({ type, values }) => {
    const col = new Column(type, Math.max(values.length, 1));
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function textChunk(values) {
  const col = new DictionaryColumn(Math.max(values.length, 1));
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

const mapping = new Map([['T.QTY', 0], ['QTY', 0], ['T.PRICE', 1], ['PRICE', 1], ['T.LABEL', 0], ['LABEL', 0]]);

function col(name) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: name };
}

function lit(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right };
}

function columnValues(column, size) {
  const out = [];
  for (let i = 0; i < size; i++) out.push(column.get(i));
  return out;
}

function scalarValues(expr, chunk) {
  const evaluate = compileExpression(expr, mapping);
  const out = [];
  for (let i = 0; i < chunk.size; i++) out.push(evaluate(chunk, chunk.activeRowIndex(i)));
  return out;
}

describe('compileColumnarProjection eligibility', () => {
  it('compiles column plus constant', () => {
    expect(compileColumnarProjection(bin(col('QTY'), '+', lit(1)), mapping)).not.toBeNull();
  });

  it('compiles column times column', () => {
    expect(compileColumnarProjection(bin(col('QTY'), '*', col('PRICE')), mapping)).not.toBeNull();
  });

  it('compiles constant minus column', () => {
    expect(compileColumnarProjection(bin(lit(1), '-', col('PRICE')), mapping)).not.toBeNull();
  });

  it('accepts division', () => {
    expect(compileColumnarProjection(bin(col('QTY'), '/', lit(2)), mapping)).not.toBeNull();
  });

  it('declines a comparison operator', () => {
    expect(compileColumnarProjection(bin(col('QTY'), '>', lit(2)), mapping)).toBeNull();
  });

  it('declines a bare column reference', () => {
    expect(compileColumnarProjection(col('QTY'), mapping)).toBeNull();
  });

  it('declines a constant-only expression', () => {
    expect(compileColumnarProjection(bin(lit(1), '+', lit(2)), mapping)).toBeNull();
  });

  it('accepts a nested expression operand', () => {
    expect(compileColumnarProjection(bin(bin(col('QTY'), '+', lit(1)), '*', lit(2)), mapping)).not.toBeNull();
  });

  it('declines a function call operand', () => {
    const upper = { kind: BoundExprKind.FUNCTION, name: 'UPPER', args: [col('LABEL')] };
    expect(compileColumnarProjection(bin(upper, '+', lit(1)), mapping)).toBeNull();
  });

  it('declines an unknown column', () => {
    expect(compileColumnarProjection(bin(col('MISSING'), '+', lit(1)), new Map())).toBeNull();
  });

  it('declines null input', () => {
    expect(compileColumnarProjection(null, mapping)).toBeNull();
  });
});

describe('compileColumnarProjection results', () => {
  it('adds a constant to every row', () => {
    const chunk = numericChunk([{ type: DataType.INT32, values: [1, 2, 3] }]);
    const compiled = compileColumnarProjection(bin(col('QTY'), '+', lit(10)), mapping);

    expect(columnValues(compiled(chunk), 3)).toEqual([11, 12, 13]);
  });

  it('multiplies two columns', () => {
    const chunk = numericChunk([
      { type: DataType.INT32, values: [1, 2, 3] },
      { type: DataType.FLOAT64, values: [2, 4, 8] },
    ]);
    const compiled = compileColumnarProjection(bin(col('QTY'), '*', col('PRICE')), mapping);

    expect(columnValues(compiled(chunk), 3)).toEqual([2, 8, 24]);
  });

  it('subtracts a column from a constant', () => {
    const chunk = numericChunk([{ type: DataType.FLOAT64, values: [0.1, 0.25] }, { type: DataType.FLOAT64, values: [0.1, 0.25] }]);
    const compiled = compileColumnarProjection(bin(lit(1), '-', col('PRICE')), mapping);

    expect(columnValues(compiled(chunk), 2)).toEqual([0.9, 0.75]);
  });

  it('propagates a null operand to a null result', () => {
    const chunk = numericChunk([{ type: DataType.INT32, values: [1, null, 3] }]);
    const compiled = compileColumnarProjection(bin(col('QTY'), '+', lit(1)), mapping);

    expect(columnValues(compiled(chunk), 3)).toEqual([2, null, 4]);
  });

  it('propagates a null from either operand column', () => {
    const chunk = numericChunk([
      { type: DataType.INT32, values: [1, 2] },
      { type: DataType.FLOAT64, values: [null, 5] },
    ]);
    const compiled = compileColumnarProjection(bin(col('QTY'), '*', col('PRICE')), mapping);

    expect(columnValues(compiled(chunk), 2)).toEqual([null, 10]);
  });

  it('honours an active selection vector', () => {
    const chunk = numericChunk([{ type: DataType.INT32, values: [1, 2, 3, 4] }]);
    chunk.setSelectionVector(Uint32Array.from([1, 3]), 2);
    const compiled = compileColumnarProjection(bin(col('QTY'), '+', lit(100)), mapping);

    expect(columnValues(compiled(chunk), 2)).toEqual([102, 104]);
  });

  it('produces an empty column for an empty chunk', () => {
    const chunk = numericChunk([{ type: DataType.INT32, values: [] }]);
    const compiled = compileColumnarProjection(bin(col('QTY'), '+', lit(1)), mapping);

    expect(compiled(chunk).length).toBe(0);
  });

  it('declines at runtime when the column is not fixed width', () => {
    const compiled = compileColumnarProjection(bin(col('LABEL'), '+', lit(1)), mapping);

    expect(compiled(textChunk(['a', 'b']))).toBeNull();
  });

  it('declines at runtime for INT64 columns so bigint semantics stay exact', () => {
    const chunk = numericChunk([{ type: DataType.INT64, values: [1n, 2n] }]);
    const compiled = compileColumnarProjection(bin(col('QTY'), '+', lit(1)), mapping);

    expect(compiled(chunk)).toBeNull();
  });

  it('returns a float column regardless of the input types', () => {
    const chunk = numericChunk([{ type: DataType.INT32, values: [1, 2] }]);
    const compiled = compileColumnarProjection(bin(col('QTY'), '*', lit(2)), mapping);

    expect(compiled(chunk).dataType).toBe(DataType.FLOAT64);
  });
});

describe('compileColumnarProjection conformance with the scalar evaluator', () => {
  const cases = [
    ['column plus constant', bin(col('QTY'), '+', lit(7))],
    ['column minus constant', bin(col('QTY'), '-', lit(3))],
    ['column times constant', bin(col('QTY'), '*', lit(2))],
    ['constant minus column', bin(lit(100), '-', col('QTY'))],
    ['column plus column', bin(col('QTY'), '+', col('PRICE'))],
    ['column times column', bin(col('QTY'), '*', col('PRICE'))],
    ['column minus column', bin(col('QTY'), '-', col('PRICE'))],
  ];

  function fixture() {
    return numericChunk([
      { type: DataType.INT32, values: [1, -4, 0, null, 9] },
      { type: DataType.FLOAT64, values: [2.5, 0, null, 4, -1.5] },
    ]);
  }

  for (const [label, expr] of cases) {
    it(`matches the scalar evaluator for ${label}`, () => {
      const chunk = fixture();
      const compiled = compileColumnarProjection(expr, mapping);

      expect(columnValues(compiled(chunk), chunk.size)).toEqual(scalarValues(expr, chunk));
    });
  }

  it('matches the scalar evaluator under a selection vector', () => {
    for (const [label, expr] of cases) {
      const chunk = fixture();
      chunk.setSelectionVector(Uint32Array.from([0, 2, 4]), 3);
      const compiled = compileColumnarProjection(expr, mapping);

      expect(columnValues(compiled(chunk), chunk.size), label).toEqual(scalarValues(expr, chunk));
    }
  });

  const denseFixtures = [
    ['integers and floats', [
      { type: DataType.INT32, values: [1, -4, 0, 9] },
      { type: DataType.FLOAT64, values: [2.5, 8, 3, -1.5] },
    ]],
    ['signed zeroes', [
      { type: DataType.FLOAT64, values: [0, -0, 1, -1] },
      { type: DataType.FLOAT64, values: [-0, 0, -1, 1] },
    ]],
    ['integers past 32-bit range', [
      { type: DataType.INT32, values: [2000000000, -2000000000] },
      { type: DataType.INT32, values: [2000000000, -2000000000] },
    ]],
    ['booleans', [
      { type: DataType.BOOLEAN, values: [true, false, true] },
      { type: DataType.BOOLEAN, values: [false, true, true] },
    ]],
    ['dates', [
      { type: DataType.DATE, values: [19000, 0, -5] },
      { type: DataType.DATE, values: [1, 2, 3] },
    ]],
    ['float extremes', [
      { type: DataType.FLOAT64, values: [1e308, -1e308, 5e-324] },
      { type: DataType.FLOAT64, values: [1e308, 1e308, 5e-324] },
    ]],
  ];

  for (const [fixtureName, columns] of denseFixtures) {
    it(`matches the scalar evaluator on the dense path over ${fixtureName}`, () => {
      for (const [label, expr] of cases) {
        const chunk = numericChunk(columns);
        expect(chunk.columns.some(column => column.hasNulls), `${fixtureName} must exercise the dense path`).toBe(false);
        const compiled = compileColumnarProjection(expr, mapping);

        const produced = columnValues(compiled(chunk), chunk.size);
        const expected = scalarValues(expr, chunk);
        expect(produced, `${fixtureName}/${label}`).toEqual(expected);
        produced.forEach((value, i) => {
          expect(Object.is(value, expected[i]), `${fixtureName}/${label} row ${i} sign`).toBe(true);
        });
      }
    });
  }
});

describe('columnar results match the scalar evaluator', () => {
  const chunk = numericChunk([
    { type: 'INT32', values: [2, 4, 0, 7] },
    { type: 'FLOAT64', values: [1.5, 0, 3.25, 2] },
  ]);

  const cases = {
    'division by a column that holds zero': bin(col('QTY'), '/', col('PRICE')),
    'division by a literal': bin(col('QTY'), '/', lit(2)),
    'nested arithmetic': bin(bin(col('QTY'), '+', lit(1)), '*', bin(col('QTY'), '-', lit(1))),
    'nested division inside multiplication': bin(bin(col('QTY'), '/', col('PRICE')), '*', lit(2)),
    'unary negation': { kind: BoundExprKind.UNARY, op: '-', operand: bin(col('QTY'), '+', lit(1)) },
    'column plus column': bin(col('QTY'), '+', col('PRICE')),
    'literal minus column': bin(lit(10), '-', col('QTY')),
  };

  for (const [name, expr] of Object.entries(cases)) {
    it(`agrees on ${name}`, () => {
      const columnar = compileColumnarProjection(expr, mapping);
      expect(columnar).not.toBeNull();
      const produced = columnar(chunk);

      const scalar = compileExpression(expr, mapping);
      for (let i = 0; i < chunk.size; i++) {
        expect(produced.get(i)).toEqual(scalar(chunk, i));
      }
    });
  }

  it('propagates nulls through a nested expression', () => {
    const nullable = numericChunk([
      { type: 'INT32', values: [1, null, 3] },
      { type: 'FLOAT64', values: [2, 2, null] },
    ]);
    const expr = bin(bin(col('QTY'), '+', lit(1)), '*', col('PRICE'));

    const produced = compileColumnarProjection(expr, mapping)(nullable);
    const scalar = compileExpression(expr, mapping);
    for (let i = 0; i < nullable.size; i++) {
      expect(produced.get(i)).toEqual(scalar(nullable, i));
    }
  });

  it('honours a selection vector the way the scalar evaluator does', () => {
    const selected = numericChunk([
      { type: 'INT32', values: [1, 2, 3, 4] },
      { type: 'FLOAT64', values: [10, 20, 30, 40] },
    ]);
    selected.selectionVector = new Uint32Array([1, 3]);
    selected.size = 2;

    const expr = bin(bin(col('QTY'), '*', lit(2)), '+', col('PRICE'));
    const produced = compileColumnarProjection(expr, mapping)(selected);
    const scalar = compileExpression(expr, mapping);

    for (let i = 0; i < selected.size; i++) {
      expect(produced.get(i)).toEqual(scalar(selected, selected.activeRowIndex(i)));
    }
  });
});
