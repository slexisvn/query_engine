import { DataType } from '../storage/data-type.js';

export function inferArithmeticType(left, right) {
  if (left === DataType.FLOAT64 || right === DataType.FLOAT64) return DataType.FLOAT64;
  if (left === DataType.DECIMAL || right === DataType.DECIMAL) return DataType.DECIMAL;
  if (left === DataType.INT64 || right === DataType.INT64) return DataType.INT64;
  if (left === DataType.DATE) return DataType.DATE;
  return DataType.INT32;
}

export function inferComparisonType() {
  return DataType.BOOLEAN;
}

export function inferLogicalType() {
  return DataType.BOOLEAN;
}

export function inferConcatType() {
  return DataType.VARCHAR;
}

export function inferAggregateResultType(name, argType) {
  switch (name.toUpperCase()) {
    case 'COUNT':
    case 'COUNT_STAR':
      return DataType.INT64;
    case 'AVG':
      return DataType.FLOAT64;
    case 'SUM':
    case 'MIN':
    case 'MAX':
      return argType || DataType.FLOAT64;
    default:
      return DataType.FLOAT64;
  }
}
