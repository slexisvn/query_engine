import { DataType, isTemporal } from '../storage/data-type.js';

const WIDENING_ARITHMETIC_OPS: ReadonlySet<string> = new Set(['+', '-', '*']);

const INTEGER_TYPES: ReadonlySet<DataType> = new Set([DataType.INT32, DataType.INT64]);

export function inferArithmeticType(left: DataType | null, right: DataType | null, op: string): DataType {
  const leftTemporal = left !== null && isTemporal(left);
  const rightTemporal = right !== null && isTemporal(right);
  if (leftTemporal && rightTemporal) return op === '-' ? DataType.INT32 : left!;
  if (leftTemporal) return left!;
  if (rightTemporal) return right!;
  if (op === '/') return DataType.FLOAT64;
  if (left === DataType.FLOAT64 || right === DataType.FLOAT64) return DataType.FLOAT64;
  if (left === DataType.DECIMAL || right === DataType.DECIMAL) return DataType.DECIMAL;
  if (WIDENING_ARITHMETIC_OPS.has(op)) return DataType.INT64;
  if (left === DataType.INT64 || right === DataType.INT64) return DataType.INT64;
  return DataType.INT32;
}

export function inferAggregateType(name: string, argType: DataType | null): DataType {
  switch (name.toUpperCase()) {
    case 'COUNT':
    case 'COUNT_STAR':
      return DataType.INT64;
    case 'AVG':
      return DataType.FLOAT64;
    case 'SUM':
      if (!argType) return DataType.FLOAT64;
      return INTEGER_TYPES.has(argType) ? DataType.INT64 : argType;
    case 'MIN':
    case 'MAX':
      return argType ?? DataType.FLOAT64;
    default:
      return DataType.FLOAT64;
  }
}

export function inferComparisonType(): DataType {
  return DataType.BOOLEAN;
}

export function inferLogicalType(): DataType {
  return DataType.BOOLEAN;
}
