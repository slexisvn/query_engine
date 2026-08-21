import { bitPackedEncoder } from './bit-packed.js';
import { frameOfReferenceEncoder } from './frame-of-reference.js';
import { runLengthEncoder } from './run-length.js';
import type { ColumnEncoder, EncodingKind } from './encoding-types.js';

const REGISTERED_ENCODERS: ReadonlyArray<ColumnEncoder> = [
  runLengthEncoder,
  bitPackedEncoder,
  frameOfReferenceEncoder,
];

export const COLUMN_ENCODERS: ReadonlyMap<EncodingKind, ColumnEncoder> =
  new Map(REGISTERED_ENCODERS.map(encoder => [encoder.kind, encoder]));

const ENCODERS_BY_ID: ReadonlyMap<number, ColumnEncoder> =
  new Map(REGISTERED_ENCODERS.map(encoder => [encoder.id, encoder]));

export function encoderForKind(kind: EncodingKind): ColumnEncoder {
  const encoder = COLUMN_ENCODERS.get(kind);
  if (!encoder) throw new Error(`Unknown column encoding ${kind}`);
  return encoder;
}

export function encoderForId(id: number): ColumnEncoder {
  const encoder = ENCODERS_BY_ID.get(id);
  if (!encoder) throw new Error(`Unknown column encoding id ${id}`);
  return encoder;
}
