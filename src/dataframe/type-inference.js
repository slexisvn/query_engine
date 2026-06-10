import {
  DataType,
  isNumeric,
  DECIMAL_SCALE_NUMBER,
  dateToEpochDays,
} from '../storage/data-type.js';

const NUMERIC_RANK = {
  [DataType.INT32]: 1,
  [DataType.INT64]: 2,
  [DataType.DECIMAL]: 3,
  [DataType.FLOAT64]: 4,
};

export function inferValueType(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return DataType.BOOLEAN;
  if (typeof value === 'bigint') return DataType.INT64;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? DataType.INT32 : DataType.FLOAT64;
  }
  if (value instanceof Date) return DataType.TIMESTAMP;
  return DataType.VARCHAR;
}

export function reconcileTypes(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  if (a === b) return a;
  if (isNumeric(a) && isNumeric(b)) {
    return NUMERIC_RANK[a] >= NUMERIC_RANK[b] ? a : b;
  }
  return DataType.VARCHAR;
}

export function inferColumnType(values) {
  let resolved = null;
  for (const value of values) {
    resolved = reconcileTypes(resolved, inferValueType(value));
  }
  return resolved === null ? DataType.VARCHAR : resolved;
}

export function coerceForColumn(value, dataType) {
  if (value === null || value === undefined) return null;
  switch (dataType) {
    case DataType.BOOLEAN:
      return value;
    case DataType.INT32:
      return Number(value);
    case DataType.FLOAT64:
      return Number(value);
    case DataType.INT64:
      return BigInt(value);
    case DataType.DECIMAL:
      return BigInt(Math.round(Number(value) * DECIMAL_SCALE_NUMBER));
    case DataType.DATE:
      return value instanceof Date
        ? dateToEpochDays(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
        : Number(value);
    case DataType.TIMESTAMP:
      return value instanceof Date ? BigInt(value.getTime()) : BigInt(value);
    case DataType.VARCHAR:
      return String(value);
    default:
      return value;
  }
}
