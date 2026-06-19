export enum DataType {
  BOOLEAN = 'BOOLEAN',
  INT32 = 'INT32',
  INT64 = 'INT64',
  FLOAT64 = 'FLOAT64',
  DECIMAL = 'DECIMAL',
  VARCHAR = 'VARCHAR',
  DATE = 'DATE',
  TIMESTAMP = 'TIMESTAMP',
}

export type ColumnValue = string | number | bigint | boolean | null;

export type AnyTypedArray = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float64Array | BigInt64Array;

export interface TypedArrayCtor<T extends AnyTypedArray> {
  readonly BYTES_PER_ELEMENT: number;
  new (length: number): T;
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): T;
}

export interface ColumnSchema {
  name: string;
  dataType: DataType;
}

export const FIXED_WIDTH_TYPES = new Set<DataType>([
  DataType.BOOLEAN,
  DataType.INT32,
  DataType.INT64,
  DataType.FLOAT64,
  DataType.DECIMAL,
  DataType.DATE,
  DataType.TIMESTAMP,
]);

const TYPE_TO_ARRAY: Partial<Record<DataType, TypedArrayCtor<AnyTypedArray>>> = {
  [DataType.BOOLEAN]: Uint8Array,
  [DataType.INT32]: Int32Array,
  [DataType.INT64]: BigInt64Array,
  [DataType.FLOAT64]: Float64Array,
  [DataType.DECIMAL]: BigInt64Array,
  [DataType.DATE]: Int32Array,
  [DataType.TIMESTAMP]: BigInt64Array,
};

const TYPE_TO_BYTE_WIDTH: Partial<Record<DataType, number>> = {
  [DataType.BOOLEAN]: 1,
  [DataType.INT32]: 4,
  [DataType.INT64]: 8,
  [DataType.FLOAT64]: 8,
  [DataType.DECIMAL]: 8,
  [DataType.DATE]: 4,
  [DataType.TIMESTAMP]: 8,
};

export function typedArrayCtorFor(dataType: DataType): TypedArrayCtor<AnyTypedArray> {
  const Ctor = TYPE_TO_ARRAY[dataType];
  if (!Ctor) {
    throw new Error(`No TypedArray for type ${dataType}`);
  }
  return Ctor;
}

export function typedArrayFor(dataType: DataType, length: number): AnyTypedArray {
  return new (typedArrayCtorFor(dataType))(length);
}

export function byteWidthFor(dataType: DataType): number {
  return TYPE_TO_BYTE_WIDTH[dataType] ?? 0;
}

export function isFixedWidth(dataType: DataType): boolean {
  return FIXED_WIDTH_TYPES.has(dataType);
}

export function isNumeric(dataType: DataType): boolean {
  return dataType === DataType.INT32
    || dataType === DataType.INT64
    || dataType === DataType.FLOAT64
    || dataType === DataType.DECIMAL;
}

export function isTemporal(dataType: DataType): boolean {
  return dataType === DataType.DATE || dataType === DataType.TIMESTAMP;
}

export function isComparable(a: DataType, b: DataType): boolean {
  if (a === b) return true;
  if (isNumeric(a) && isNumeric(b)) return true;
  if (isTemporal(a) && isTemporal(b)) return true;
  return false;
}

let _decimalScale = 100n;
let _decimalScaleNumber = 100;

export function getDecimalScale(): bigint { return _decimalScale; }
export function getDecimalScaleNumber(): number { return _decimalScaleNumber; }

export function setDecimalScale(digits: number): void {
  _decimalScaleNumber = Math.pow(10, digits);
  _decimalScale = BigInt(_decimalScaleNumber);
}

export const DECIMAL_SCALE = 100n;
export const DECIMAL_SCALE_NUMBER = 100;

export function dateToEpochDays(year: number, month: number, day: number): number {
  const ms = Date.UTC(year, month - 1, day);
  return Math.floor(ms / 86400000);
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface TimestampParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

export function epochDaysToDate(days: number): DateParts {
  const ms = days * 86400000;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function timestampToEpochMs(year: number, month: number, day: number, hour: number, minute: number, second: number, ms = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}

export function epochMsToTimestamp(epochMs: number): TimestampParts {
  const d = new Date(epochMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
  };
}

export function epochDaysToEpochMs(days: number): number {
  return days * 86400000;
}

export function epochMsToEpochDays(ms: number): number {
  return Math.floor(ms / 86400000);
}
