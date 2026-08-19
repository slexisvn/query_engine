import { Column } from '../storage/column.js';
import { BoundExprKind, type BoundExpr } from '../binder/expression-binder.js';
import { DataType, isFixedWidth } from '../storage/data-type.js';
import { resolveColumnIndex } from './column-resolve.js';
import type { DataChunk } from '../storage/chunk.js';
import type { ColumnMapping } from './execution-types.js';

export type ColumnarProjection = (chunk: DataChunk) => Column | null;

type NumericBinaryOp = (left: number, right: number) => number;

const ARITHMETIC_OPS: Record<string, NumericBinaryOp> = {
  '+': (left, right) => left + right,
  '-': (left, right) => left - right,
  '*': (left, right) => left * right,
};

interface ColumnOperand {
  kind: 'column';
  index: number;
}

interface ConstantOperand {
  kind: 'constant';
  value: number;
}

type Operand = ColumnOperand | ConstantOperand;

function resolveOperand(expr: BoundExpr | undefined, columnMapping: ColumnMapping | null): Operand | null {
  if (!expr) return null;

  if (expr.kind === BoundExprKind.COLUMN_REF) {
    const index = resolveColumnIndex(expr, columnMapping);
    return index >= 0 ? { kind: 'column', index } : null;
  }

  if (expr.kind === BoundExprKind.LITERAL) {
    const value = typeof expr.value === 'bigint' ? Number(expr.value) : expr.value;
    return typeof value === 'number' && Number.isFinite(value) ? { kind: 'constant', value } : null;
  }

  return null;
}

function numericColumn(chunk: DataChunk, operand: Operand): Column | null {
  if (operand.kind === 'constant') return null;

  const column = chunk.columns[operand.index];
  if (!(column instanceof Column) || !column.data) return null;
  if (!isFixedWidth(column.dataType)) return null;
  if (column.dataType === DataType.INT64 || column.dataType === DataType.DECIMAL) return null;
  return column;
}

function operandValue(chunk: DataChunk, operand: Operand, row: number): number {
  if (operand.kind === 'constant') return operand.value;
  return (chunk.columns[operand.index] as Column).data![row] as number;
}

function operandIsNull(chunk: DataChunk, operand: Operand, row: number): boolean {
  return operand.kind === 'column' && chunk.columns[operand.index].isNull(row);
}

export function compileColumnarProjection(
  expr: BoundExpr | null | undefined,
  columnMapping: ColumnMapping | null,
): ColumnarProjection | null {
  if (!expr || expr.kind !== BoundExprKind.BINARY) return null;

  const apply = ARITHMETIC_OPS[expr.op];
  if (!apply) return null;

  const left = resolveOperand(expr.left, columnMapping);
  const right = resolveOperand(expr.right, columnMapping);
  if (!left || !right) return null;
  if (left.kind === 'constant' && right.kind === 'constant') return null;

  return (chunk: DataChunk) => {
    const leftColumn = left.kind === 'column' ? numericColumn(chunk, left) : null;
    const rightColumn = right.kind === 'column' ? numericColumn(chunk, right) : null;
    if (left.kind === 'column' && !leftColumn) return null;
    if (right.kind === 'column' && !rightColumn) return null;

    const size = chunk.size;
    const output = new Column(DataType.FLOAT64, Math.max(size, 1));
    const nullable = !!leftColumn?.hasNulls || !!rightColumn?.hasNulls;

    if (nullable) {
      for (let i = 0; i < size; i++) {
        const row = chunk.activeRowIndex(i);
        const isNull = operandIsNull(chunk, left, row) || operandIsNull(chunk, right, row);
        output.set(i, isNull ? null : apply(operandValue(chunk, left, row), operandValue(chunk, right, row)));
      }
    } else {
      const target = output.data as Float64Array;
      for (let i = 0; i < size; i++) {
        const row = chunk.activeRowIndex(i);
        target[i] = apply(operandValue(chunk, left, row), operandValue(chunk, right, row));
      }
    }

    output.length = size;
    return output;
  };
}
