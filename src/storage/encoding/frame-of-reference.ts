import { Config } from '../../config.js';
import { byteWidthFor, type DataType, type TypedArrayCtor } from '../data-type.js';
import { UINT8_BYTES, INT64_BYTES, type ByteReader, type ByteWriter } from './byte-io.js';
import { EncodingKind } from './encoding-types.js';
import type {
  ColumnEncoder, EncodableVector, EncodedVector, EncodingPlan,
  IntegerArray, IntegerColumnStats,
} from './encoding-types.js';
import { integerArray, isWideInteger } from './integer-values.js';

const FOR_HEADER_BYTES = UINT8_BYTES + INT64_BYTES;

type OffsetArray = Uint8Array | Uint16Array | Uint32Array;

interface OffsetContainer {
  readonly width: number;
  readonly limit: bigint;
  readonly Ctor: TypedArrayCtor<OffsetArray>;
}

const OFFSET_CONTAINERS: ReadonlyArray<OffsetContainer> = [
  { width: 1, limit: 1n << 8n, Ctor: Uint8Array },
  { width: 2, limit: 1n << 16n, Ctor: Uint16Array },
  { width: 4, limit: 1n << 32n, Ctor: Uint32Array },
];

function containerForRange(range: bigint): OffsetContainer | null {
  for (const container of OFFSET_CONTAINERS) {
    if (range < container.limit) return container;
  }
  return null;
}

function containerForWidth(width: number): OffsetContainer {
  const container = OFFSET_CONTAINERS.find(candidate => candidate.width === width);
  if (!container) throw new Error(`Unsupported frame-of-reference offset width ${width}`);
  return container;
}

export class FrameOfReferenceVector implements EncodedVector {
  readonly kind = EncodingKind.FRAME_OF_REFERENCE;
  readonly dataType: DataType;
  readonly length: number;
  readonly anchor: bigint;
  readonly offsets: OffsetArray;
  readonly wide: boolean;
  readonly narrowAnchor: number;

  constructor(dataType: DataType, length: number, anchor: bigint, offsets: OffsetArray) {
    this.dataType = dataType;
    this.length = length;
    this.anchor = anchor;
    this.offsets = offsets;
    this.wide = isWideInteger(dataType);
    this.narrowAnchor = Number(anchor);
  }

  valueAt(index: number): number | bigint {
    return this.wide
      ? this.anchor + BigInt(this.offsets[index])
      : this.narrowAnchor + this.offsets[index];
  }

  decode(): IntegerArray {
    const target = integerArray(this.dataType, this.length);
    const offsets = this.offsets;
    if (target instanceof BigInt64Array) {
      const anchor = this.anchor;
      for (let index = 0; index < this.length; index++) target[index] = anchor + BigInt(offsets[index]);
    } else {
      const anchor = this.narrowAnchor;
      for (let index = 0; index < this.length; index++) target[index] = anchor + offsets[index];
    }
    return target;
  }

  byteSize(): number {
    return FOR_HEADER_BYTES + this.offsets.byteLength;
  }

  writeTo(writer: ByteWriter): void {
    writer.u8(this.offsets.BYTES_PER_ELEMENT);
    writer.i64(this.anchor);
    writer.bytes(this.offsets);
  }
}

export const frameOfReferenceEncoder: ColumnEncoder = {
  kind: EncodingKind.FRAME_OF_REFERENCE,
  id: 3,

  plan(stats: IntegerColumnStats, dataType: DataType): EncodingPlan | null {
    const container = containerForRange(stats.max - stats.min);
    if (!container) return null;

    return {
      bytes: FOR_HEADER_BYTES + stats.length * container.width,
      withinThreshold: container.width <= byteWidthFor(dataType) * Config.encodingForMaxWidthRatio,
    };
  },

  encode(source: EncodableVector): EncodedVector {
    const anchor = source.stats.min;
    const container = containerForRange(source.stats.max - anchor);
    if (!container) throw new Error('Frame-of-reference range exceeds the widest offset container');

    const offsets = new container.Ctor(source.length);
    const values = source.values;

    if (values instanceof BigInt64Array) {
      for (let index = 0; index < source.length; index++) offsets[index] = Number(values[index] - anchor);
    } else {
      const narrowAnchor = Number(anchor);
      for (let index = 0; index < source.length; index++) offsets[index] = values[index] - narrowAnchor;
    }

    return new FrameOfReferenceVector(source.dataType, source.length, anchor, offsets);
  },

  read(reader: ByteReader, dataType: DataType, length: number): EncodedVector {
    const container = containerForWidth(reader.u8());
    const anchor = reader.i64();
    const offsets = reader.typed(container.Ctor, length);
    return new FrameOfReferenceVector(dataType, length, anchor, offsets);
  },
};
