import { Column } from '../../src/storage/column.js';
import { DataType } from '../../src/storage/data-type.js';
import { ByteReader, ByteWriter } from '../../src/storage/encoding/byte-io.js';
import { summarizeIntegers } from '../../src/storage/encoding/integer-values.js';

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;
export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

export function integerArrayOf(dataType, values) {
  return dataType === DataType.INT64 ? BigInt64Array.from(values) : Int32Array.from(values);
}

export function sourceOf(dataType, values) {
  const data = integerArrayOf(dataType, values);
  return { dataType, length: data.length, values: data, stats: summarizeIntegers(data, data.length) };
}

export function readBack(vector) {
  const values = [];
  for (let i = 0; i < vector.length; i++) values.push(vector.valueAt(i));
  return values;
}

export function serializeVector(vector) {
  const buffer = Buffer.alloc(vector.byteSize());
  const writer = new ByteWriter(buffer);
  vector.writeTo(writer);
  return { buffer, written: writer.offset };
}

export function roundTripVector(encoder, vector) {
  const { buffer, written } = serializeVector(vector);
  const reader = new ByteReader(buffer);
  const restored = encoder.read(reader, vector.dataType, vector.length);
  return { restored, written, consumed: reader.offset };
}

export function columnOf(dataType, values) {
  const column = new Column(dataType, Math.max(values.length, 1));
  for (let i = 0; i < values.length; i++) column.set(i, values[i]);
  column.length = values.length;
  return column;
}

export function columnValues(column, length = column.length) {
  const values = [];
  for (let i = 0; i < length; i++) values.push(column.get(i));
  return values;
}

export function repeatRuns(runLength, runValues) {
  const values = [];
  for (const value of runValues) {
    for (let i = 0; i < runLength; i++) values.push(value);
  }
  return values;
}
