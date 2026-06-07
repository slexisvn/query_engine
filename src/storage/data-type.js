export const DataType = {
  BOOLEAN: 'BOOLEAN',
  INT32: 'INT32',
  INT64: 'INT64',
  FLOAT64: 'FLOAT64',
  DECIMAL: 'DECIMAL',
  VARCHAR: 'VARCHAR',
  DATE: 'DATE',
  TIMESTAMP: 'TIMESTAMP',
};

export const FIXED_WIDTH_TYPES = new Set([
  DataType.BOOLEAN,
  DataType.INT32,
  DataType.INT64,
  DataType.FLOAT64,
  DataType.DECIMAL,
  DataType.DATE,
  DataType.TIMESTAMP,
]);

const TYPE_TO_ARRAY = {
  [DataType.BOOLEAN]: Uint8Array,
  [DataType.INT32]: Int32Array,
  [DataType.INT64]: BigInt64Array,
  [DataType.FLOAT64]: Float64Array,
  [DataType.DECIMAL]: BigInt64Array,
  [DataType.DATE]: Int32Array,
  [DataType.TIMESTAMP]: BigInt64Array,
};

const TYPE_TO_BYTE_WIDTH = {
  [DataType.BOOLEAN]: 1,
  [DataType.INT32]: 4,
  [DataType.INT64]: 8,
  [DataType.FLOAT64]: 8,
  [DataType.DECIMAL]: 8,
  [DataType.DATE]: 4,
  [DataType.TIMESTAMP]: 8,
};

export function typedArrayFor(dataType, length) {
  const Ctor = TYPE_TO_ARRAY[dataType];
  if (!Ctor) {
    throw new Error(`No TypedArray for type ${dataType}`);
  }
  return new Ctor(length);
}

export function byteWidthFor(dataType) {
  return TYPE_TO_BYTE_WIDTH[dataType] ?? 0;
}

export function isFixedWidth(dataType) {
  return FIXED_WIDTH_TYPES.has(dataType);
}

export function isNumeric(dataType) {
  return dataType === DataType.INT32
    || dataType === DataType.INT64
    || dataType === DataType.FLOAT64
    || dataType === DataType.DECIMAL;
}

export function isTemporal(dataType) {
  return dataType === DataType.DATE || dataType === DataType.TIMESTAMP;
}

export function isComparable(a, b) {
  if (a === b) return true;
  if (isNumeric(a) && isNumeric(b)) return true;
  if (isTemporal(a) && isTemporal(b)) return true;
  return false;
}

let _decimalScale = 100n;
let _decimalScaleNumber = 100;

export function getDecimalScale() { return _decimalScale; }
export function getDecimalScaleNumber() { return _decimalScaleNumber; }

export function setDecimalScale(digits) {
  _decimalScaleNumber = Math.pow(10, digits);
  _decimalScale = BigInt(_decimalScaleNumber);
}

export const DECIMAL_SCALE = 100n;
export const DECIMAL_SCALE_NUMBER = 100;

export function dateToEpochDays(year, month, day) {
  const ms = Date.UTC(year, month - 1, day);
  return Math.floor(ms / 86400000);
}

export function epochDaysToDate(days) {
  const ms = days * 86400000;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function timestampToEpochMs(year, month, day, hour, minute, second, ms = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}

export function epochMsToTimestamp(epochMs) {
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

export function epochDaysToEpochMs(days) {
  return days * 86400000;
}

export function epochMsToEpochDays(ms) {
  return Math.floor(ms / 86400000);
}
