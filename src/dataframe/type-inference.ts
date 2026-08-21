import {
  DataType,
  isNumeric,
  DECIMAL_SCALE_NUMBER,
  dateToEpochDays,
} from '../storage/data-type.js';
import type { ColumnValue } from '../storage/data-type.js';

type InferableValue = ColumnValue | Date | undefined;

const NUMERIC_RANK: Partial<Record<DataType, number>> = {
  [DataType.INT32]: 1,
  [DataType.INT64]: 2,
  [DataType.DECIMAL]: 3,
  [DataType.FLOAT64]: 4,
};

export function reconcileTypes(a: DataType | null, b: DataType | null): DataType | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a === b) return a;
  if (isNumeric(a) && isNumeric(b)) {
    return (NUMERIC_RANK[a] as number) >= (NUMERIC_RANK[b] as number) ? a : b;
  }
  return DataType.VARCHAR;
}

export function inferValueType(value: InferableValue): DataType | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return DataType.BOOLEAN;
  if (typeof value === 'bigint') return DataType.INT64;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? DataType.INT32 : DataType.FLOAT64;
  }
  if (value instanceof Date) return DataType.TIMESTAMP;
  return DataType.VARCHAR;
}

export function inferColumnType(values: Iterable<InferableValue>): DataType {
  let resolved: DataType | null = null;
  for (const value of values) {
    resolved = reconcileTypes(resolved, inferValueType(value));
  }
  return resolved === null ? DataType.VARCHAR : resolved;
}

export function coerceForColumn(value: InferableValue, dataType: DataType): ColumnValue {
  if (value === null || value === undefined) return null;
  switch (dataType) {
    case DataType.BOOLEAN:
      return value as ColumnValue;
    case DataType.INT32:
      return Number(value);
    case DataType.FLOAT64:
      return Number(value);
    case DataType.INT64:
      return BigInt(value as Exclude<InferableValue, Date | null | undefined>);
    case DataType.DECIMAL:
      return Number(value);
    case DataType.DATE:
      return value instanceof Date
        ? dateToEpochDays(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
        : Number(value);
    case DataType.TIMESTAMP:
      return value instanceof Date ? BigInt(value.getTime()) : BigInt(value);
    case DataType.VARCHAR:
      return String(value);
    default:
      return value as ColumnValue;
  }
}
