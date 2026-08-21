import { DataType, type TypedArrayCtor } from '../data-type.js';
import type { IntegerArray, IntegerColumnStats, IntegerSource } from './encoding-types.js';

export const ENCODABLE_TYPES: ReadonlySet<DataType> = new Set([DataType.INT32, DataType.INT64]);

export function isWideInteger(dataType: DataType): boolean {
  return dataType === DataType.INT64;
}

export function integerArrayCtor(dataType: DataType): TypedArrayCtor<IntegerArray> {
  return isWideInteger(dataType) ? BigInt64Array : Int32Array;
}

export function integerArray(dataType: DataType, length: number): IntegerArray {
  return new (integerArrayCtor(dataType))(length);
}

interface RawStats<T extends number | bigint> {
  readonly min: T;
  readonly max: T;
  readonly runCount: number;
}

function scanValues<T extends number | bigint>(values: IntegerSource<T>, length: number): RawStats<T> {
  let min = values[0];
  let max = min;
  let previous = min;
  let runCount = 1;

  for (let index = 1; index < length; index++) {
    const value = values[index];
    if (value < min) min = value;
    else if (value > max) max = value;
    if (value !== previous) {
      runCount++;
      previous = value;
    }
  }

  return { min, max, runCount };
}

export function summarizeIntegers(values: IntegerArray, length: number): IntegerColumnStats {
  const raw = values instanceof BigInt64Array
    ? scanValues<bigint>(values, length)
    : scanValues<number>(values, length);
  return { length, runCount: raw.runCount, min: BigInt(raw.min), max: BigInt(raw.max) };
}
