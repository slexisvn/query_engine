import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { DictionaryColumn } from '../../src/storage/dictionary-column.js';
import { DataType } from '../../src/storage/data-type.js';

export const CONFORMANCE_COLUMNS = ['QTY', 'PRICE', 'LABEL', 'FLAG'];

export function conformanceMapping() {
  const mapping = new Map();
  CONFORMANCE_COLUMNS.forEach((name, index) => {
    mapping.set(name, index);
    mapping.set(`T.${name}`, index);
  });
  return mapping;
}

export function conformanceChunk() {
  const qty = new Column(DataType.INT32, 8);
  const price = new Column(DataType.FLOAT64, 8);
  const flag = new Column(DataType.BOOLEAN, 8);
  const label = new DictionaryColumn(8);

  const qtyValues = [1, 5, 0, -3, null, 12, 7, null];
  const priceValues = [10.5, 0, -2.25, 99.9, 4, null, 0.5, 3];
  const flagValues = [true, false, null, true, false, true, null, false];
  const labelValues = ['alpha', 'beta', null, 'alpha', 'gamma', '', 'delta', null];

  for (let i = 0; i < 8; i++) {
    qty.set(i, qtyValues[i]);
    price.set(i, priceValues[i]);
    flag.set(i, flagValues[i]);
    label.set(i, labelValues[i]);
  }
  qty.length = 8;
  price.length = 8;
  flag.length = 8;
  label.length = 8;

  return new DataChunk([qty, price, label, flag], 8);
}

function col(name) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: name };
}

function lit(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function binary(op, left, right) {
  return { kind: BoundExprKind.BINARY, op, left, right };
}

function unary(op, operand) {
  return { kind: BoundExprKind.UNARY, op, operand };
}

const COMPARISON_OPS = ['=', '<>', '<', '>', '<=', '>='];
const ARITHMETIC_OPS = ['+', '-', '*', '/', '%'];

export function conformanceExpressions() {
  const cases = [];

  cases.push({ label: 'column reference', expr: col('QTY') });
  cases.push({ label: 'nullable column reference', expr: col('PRICE') });
  cases.push({ label: 'boolean column reference', expr: col('FLAG') });
  cases.push({ label: 'string column reference', expr: col('LABEL') });
  cases.push({ label: 'integer literal', expr: lit(7) });
  cases.push({ label: 'null literal', expr: lit(null) });
  cases.push({ label: 'string literal', expr: lit('alpha') });

  for (const op of COMPARISON_OPS) {
    cases.push({ label: `column ${op} literal`, expr: binary(op, col('QTY'), lit(5)) });
    cases.push({ label: `column ${op} column`, expr: binary(op, col('QTY'), col('PRICE')) });
    cases.push({ label: `literal ${op} nullable column`, expr: binary(op, lit(4), col('PRICE')) });
    cases.push({ label: `null literal ${op} column`, expr: binary(op, lit(null), col('QTY')) });
  }

  for (const op of ARITHMETIC_OPS) {
    cases.push({ label: `column ${op} literal`, expr: binary(op, col('QTY'), lit(3)) });
    cases.push({ label: `column ${op} column`, expr: binary(op, col('QTY'), col('PRICE')) });
    cases.push({ label: `column ${op} zero`, expr: binary(op, col('QTY'), lit(0)) });
    cases.push({ label: `nullable column ${op} column`, expr: binary(op, col('PRICE'), col('QTY')) });
  }

  cases.push({ label: 'string concatenation of columns', expr: binary('||', col('LABEL'), col('LABEL')) });
  cases.push({ label: 'string concatenation with literal', expr: binary('||', col('LABEL'), lit('-suffix')) });

  cases.push({ label: 'AND of two comparisons', expr: binary('AND', binary('>', col('QTY'), lit(0)), binary('<', col('PRICE'), lit(50))) });
  cases.push({ label: 'OR of two comparisons', expr: binary('OR', binary('>', col('QTY'), lit(6)), binary('<', col('PRICE'), lit(1))) });
  cases.push({ label: 'AND with a nullable operand', expr: binary('AND', col('FLAG'), binary('>', col('PRICE'), lit(1))) });
  cases.push({ label: 'OR with a nullable operand', expr: binary('OR', col('FLAG'), binary('>', col('QTY'), lit(100))) });
  cases.push({ label: 'AND of two boolean columns', expr: binary('AND', col('FLAG'), col('FLAG')) });

  cases.push({ label: 'negated column', expr: unary('-', col('QTY')) });
  cases.push({ label: 'negated nullable column', expr: unary('-', col('PRICE')) });
  cases.push({ label: 'NOT of a boolean column', expr: unary('NOT', col('FLAG')) });
  cases.push({ label: 'NOT of a comparison', expr: unary('NOT', binary('>', col('QTY'), lit(2))) });
  cases.push({ label: 'double negation', expr: unary('-', unary('-', col('QTY'))) });

  cases.push({ label: 'nested arithmetic then comparison', expr: binary('>', binary('*', col('QTY'), lit(2)), col('PRICE')) });
  cases.push({ label: 'nested logical over arithmetic', expr: binary('AND', binary('>', binary('+', col('QTY'), lit(1)), lit(0)), binary('<>', col('LABEL'), lit('beta'))) });
  cases.push({ label: 'deeply nested arithmetic', expr: binary('-', binary('*', binary('+', col('QTY'), lit(1)), lit(3)), col('PRICE')) });

  return cases;
}
