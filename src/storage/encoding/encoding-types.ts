import type { DataType } from '../data-type.js';
import type { ByteReader, ByteWriter } from './byte-io.js';

export enum EncodingKind {
  RUN_LENGTH = 'RUN_LENGTH',
  BIT_PACKED = 'BIT_PACKED',
  FRAME_OF_REFERENCE = 'FRAME_OF_REFERENCE',
}

export type IntegerArray = Int32Array | BigInt64Array;

export interface IntegerSource<T extends number | bigint> {
  readonly [index: number]: T;
}

export interface IntegerSink<T extends number | bigint> {
  [index: number]: T;
}

export interface IntegerColumnStats {
  readonly length: number;
  readonly runCount: number;
  readonly min: bigint;
  readonly max: bigint;
}

export interface EncodableVector {
  readonly dataType: DataType;
  readonly length: number;
  readonly values: IntegerArray;
  readonly stats: IntegerColumnStats;
}

export interface EncodedVector {
  readonly kind: EncodingKind;
  readonly dataType: DataType;
  readonly length: number;
  valueAt(index: number): number | bigint;
  decode(): IntegerArray;
  byteSize(): number;
  writeTo(writer: ByteWriter): void;
}

export interface EncodingPlan {
  readonly bytes: number;
  readonly withinThreshold: boolean;
}

export interface ColumnEncoder {
  readonly kind: EncodingKind;
  readonly id: number;
  plan(stats: IntegerColumnStats, dataType: DataType): EncodingPlan | null;
  encode(source: EncodableVector): EncodedVector;
  read(reader: ByteReader, dataType: DataType, length: number): EncodedVector;
}
