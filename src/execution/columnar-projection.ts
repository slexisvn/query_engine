import { Column } from '../storage/column.js';
import { BoundExprKind, type BoundExpr } from '../binder/expression-binder.js';
import { DataType, isFixedWidth } from '../storage/data-type.js';
import { optionalColumnIndex, UNRESOLVED_COLUMN } from './column-resolve.js';
import type { DataChunk } from '../storage/chunk.js';
import type { ColumnMapping } from './execution-types.js';

export type ColumnarProjection = (chunk: DataChunk) => Column | null;

type NumericBinaryOp = (left: number, right: number) => number | null;
type NumericUnaryOp = (operand: number) => number;

const ARITHMETIC_OPS: Record<string, NumericBinaryOp> = {
  '+': (left, right) => left + right,
  '-': (left, right) => left - right,
  '*': (left, right) => left * right,
  '/': (left, right) => (right === 0 ? null : left / right),
};

const DIVIDE = '/';

const TOTAL_OPS: ReadonlySet<string> = new Set(['+', '-', '*']);

const UNARY_OPS: Record<string, NumericUnaryOp> = {
  '-': (operand) => -operand,
  '+': (operand) => operand,
};

type NumericData = Float64Array | Int32Array;

interface ConstantOperand {
  kind: 'constant';
  value: number;
}

interface VectorOperand {
  kind: 'vector';
  evaluate: ColumnarProjection;
}

type Operand = ConstantOperand | VectorOperand;

function numericData(column: Column): NumericData | null {
  if (!column.data) return null;
  if (!isFixedWidth(column.dataType)) return null;
  if (column.dataType === DataType.INT64 || column.dataType === DataType.DECIMAL) return null;
  return column.data as NumericData;
}

function denseColumn(chunk: DataChunk, index: number): Column | null {
  const source = chunk.columns[index];
  if (!(source instanceof Column)) return null;
  const data = numericData(source);
  if (!data) return null;
  if (!chunk.selectionVector) return source;

  const size = chunk.size;
  const gathered = new Column(DataType.FLOAT64, Math.max(size, 1));
  for (let i = 0; i < size; i++) {
    const row = chunk.activeRowIndex(i);
    gathered.set(i, source.isNull(row) ? null : data[row]);
  }
  gathered.length = size;
  return gathered;
}

function literalNumber(expr: BoundExpr): number | null {
  if (expr.kind !== BoundExprKind.LITERAL) return null;
  const value = typeof expr.value === 'bigint' ? Number(expr.value) : expr.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compileOperand(expr: BoundExpr | null | undefined, columnMapping: ColumnMapping | null): Operand | null {
  if (!expr) return null;

  if (expr.kind === BoundExprKind.LITERAL) {
    const value = literalNumber(expr);
    return value === null ? null : { kind: 'constant', value };
  }

  if (expr.kind === BoundExprKind.COLUMN_REF) {
    const index = optionalColumnIndex(expr, columnMapping);
    if (index === UNRESOLVED_COLUMN) return null;
    return { kind: 'vector', evaluate: (chunk: DataChunk) => denseColumn(chunk, index) };
  }

  if (expr.kind === BoundExprKind.UNARY) {
    const apply = UNARY_OPS[expr.op];
    if (!apply) return null;
    const operand = compileOperand(expr.operand, columnMapping);
    if (!operand) return null;
    if (operand.kind === 'constant') return { kind: 'constant', value: apply(operand.value) };
    return { kind: 'vector', evaluate: unaryProjection(operand, apply) };
  }

  if (expr.kind === BoundExprKind.BINARY) {
    const apply = ARITHMETIC_OPS[expr.op];
    if (!apply) return null;
    const left = compileOperand(expr.left, columnMapping);
    const right = compileOperand(expr.right, columnMapping);
    if (!left || !right) return null;
    if (left.kind === 'constant' && right.kind === 'constant') {
      const folded = apply(left.value, right.value);
      return folded === null ? null : { kind: 'constant', value: folded };
    }
    const total = TOTAL_OPS.has(expr.op)
      || (expr.op === DIVIDE && right.kind === 'constant' && right.value !== 0);
    return { kind: 'vector', evaluate: binaryProjection(left, right, apply, total) };
  }

  return null;
}

function unaryProjection(operand: VectorOperand, apply: NumericUnaryOp): ColumnarProjection {
  return (chunk: DataChunk) => {
    const source = operand.evaluate(chunk);
    if (!source) return null;
    const data = numericData(source);
    if (!data) return null;

    const size = chunk.size;
    const output = new Column(DataType.FLOAT64, Math.max(size, 1));
    if (source.hasNulls) {
      for (let i = 0; i < size; i++) output.set(i, source.isNull(i) ? null : apply(data[i]));
    } else {
      const target = output.data as Float64Array;
      for (let i = 0; i < size; i++) target[i] = apply(data[i]);
    }
    output.length = size;
    return output;
  };
}

function binaryProjection(left: Operand, right: Operand, apply: NumericBinaryOp, total: boolean): ColumnarProjection {
  return (chunk: DataChunk) => {
    const leftColumn = left.kind === 'vector' ? left.evaluate(chunk) : null;
    if (left.kind === 'vector' && !leftColumn) return null;
    const rightColumn = right.kind === 'vector' ? right.evaluate(chunk) : null;
    if (right.kind === 'vector' && !rightColumn) return null;

    const leftData = leftColumn ? numericData(leftColumn) : null;
    const rightData = rightColumn ? numericData(rightColumn) : null;
    if (leftColumn && !leftData) return null;
    if (rightColumn && !rightData) return null;

    const size = chunk.size;
    const output = new Column(DataType.FLOAT64, Math.max(size, 1));
    const leftConstant = left.kind === 'constant' ? left.value : 0;
    const rightConstant = right.kind === 'constant' ? right.value : 0;

    if (!total || leftColumn?.hasNulls || rightColumn?.hasNulls) {
      for (let i = 0; i < size; i++) {
        if (leftColumn?.isNull(i) || rightColumn?.isNull(i)) {
          output.set(i, null);
          continue;
        }
        output.set(i, apply(leftData ? leftData[i] : leftConstant, rightData ? rightData[i] : rightConstant));
      }
    } else {
      const target = output.data as Float64Array;
      if (leftData && rightData) {
        for (let i = 0; i < size; i++) target[i] = apply(leftData[i], rightData[i]) as number;
      } else if (leftData) {
        for (let i = 0; i < size; i++) target[i] = apply(leftData[i], rightConstant) as number;
      } else {
        for (let i = 0; i < size; i++) target[i] = apply(leftConstant, rightData![i]) as number;
      }
    }

    output.length = size;
    return output;
  };
}

export function compileColumnarProjection(
  expr: BoundExpr | null | undefined,
  columnMapping: ColumnMapping | null,
): ColumnarProjection | null {
  if (!expr) return null;
  if (expr.kind !== BoundExprKind.BINARY && expr.kind !== BoundExprKind.UNARY) return null;

  const operand = compileOperand(expr, columnMapping);
  return operand && operand.kind === 'vector' ? operand.evaluate : null;
}
