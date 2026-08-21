import { Config } from '../../config.js';
import { byteWidthFor, type DataType } from '../data-type.js';
import { UINT8_BYTES, UINT32_BYTES, type ByteReader, type ByteWriter } from './byte-io.js';
import { EncodingKind } from './encoding-types.js';
import type {
  ColumnEncoder, EncodableVector, EncodedVector, EncodingPlan,
  IntegerArray, IntegerColumnStats,
} from './encoding-types.js';
import { integerArray, isWideInteger } from './integer-values.js';

const PACK_WORD_BITS = 32;
const PACK_HEADER_BYTES = UINT8_BYTES + UINT32_BYTES;
const BITS_PER_BYTE = 8;
const ALL_WORD_BITS = -1;

function bitLength(value: bigint): number {
  let bits = 0;
  let remaining = value;
  while (remaining > 0n) {
    bits++;
    remaining >>= 1n;
  }
  return bits;
}

function packedBitWidth(stats: IntegerColumnStats): number {
  return Math.max(1, bitLength(stats.max));
}

function packedWordCount(length: number, bitWidth: number): number {
  return Math.ceil((length * bitWidth) / PACK_WORD_BITS);
}

function packValue(words: Uint32Array, index: number, bitWidth: number, value: number): void {
  const bitPosition = index * bitWidth;
  const wordIndex = bitPosition >>> 5;
  const bitOffset = bitPosition & 31;

  words[wordIndex] |= value << bitOffset;
  if (bitOffset > 0 && bitOffset + bitWidth > PACK_WORD_BITS) {
    words[wordIndex + 1] |= value >>> (PACK_WORD_BITS - bitOffset);
  }
}

export class BitPackedVector implements EncodedVector {
  readonly kind = EncodingKind.BIT_PACKED;
  readonly dataType: DataType;
  readonly length: number;
  readonly bitWidth: number;
  readonly words: Uint32Array;
  readonly mask: number;
  readonly wide: boolean;

  constructor(dataType: DataType, length: number, bitWidth: number, words: Uint32Array) {
    this.dataType = dataType;
    this.length = length;
    this.bitWidth = bitWidth;
    this.words = words;
    this.mask = bitWidth === PACK_WORD_BITS ? ALL_WORD_BITS : (1 << bitWidth) - 1;
    this.wide = isWideInteger(dataType);
  }

  unpack(index: number): number {
    const bitPosition = index * this.bitWidth;
    const wordIndex = bitPosition >>> 5;
    const bitOffset = bitPosition & 31;

    let raw = this.words[wordIndex] >>> bitOffset;
    if (bitOffset > 0 && bitOffset + this.bitWidth > PACK_WORD_BITS) {
      raw |= this.words[wordIndex + 1] << (PACK_WORD_BITS - bitOffset);
    }
    return (raw & this.mask) >>> 0;
  }

  valueAt(index: number): number | bigint {
    const raw = this.unpack(index);
    return this.wide ? BigInt(raw) : raw;
  }

  decode(): IntegerArray {
    const target = integerArray(this.dataType, this.length);
    if (target instanceof BigInt64Array) {
      for (let index = 0; index < this.length; index++) target[index] = BigInt(this.unpack(index));
    } else {
      for (let index = 0; index < this.length; index++) target[index] = this.unpack(index);
    }
    return target;
  }

  byteSize(): number {
    return PACK_HEADER_BYTES + this.words.byteLength;
  }

  writeTo(writer: ByteWriter): void {
    writer.u8(this.bitWidth);
    writer.u32(this.words.length);
    writer.bytes(this.words);
  }
}

export const bitPackedEncoder: ColumnEncoder = {
  kind: EncodingKind.BIT_PACKED,
  id: 2,

  plan(stats: IntegerColumnStats, dataType: DataType): EncodingPlan | null {
    if (stats.min < 0n) return null;
    const bitWidth = packedBitWidth(stats);
    if (bitWidth > PACK_WORD_BITS) return null;

    const nativeBits = byteWidthFor(dataType) * BITS_PER_BYTE;
    return {
      bytes: PACK_HEADER_BYTES + packedWordCount(stats.length, bitWidth) * UINT32_BYTES,
      withinThreshold: bitWidth <= nativeBits * Config.encodingBitPackMaxWidthRatio,
    };
  },

  encode(source: EncodableVector): EncodedVector {
    const bitWidth = packedBitWidth(source.stats);
    const words = new Uint32Array(packedWordCount(source.length, bitWidth));
    const values = source.values;
    const wide = values instanceof BigInt64Array;

    for (let index = 0; index < source.length; index++) {
      const value = wide ? Number((values as BigInt64Array)[index]) : (values as Int32Array)[index];
      packValue(words, index, bitWidth, value);
    }

    return new BitPackedVector(source.dataType, source.length, bitWidth, words);
  },

  read(reader: ByteReader, dataType: DataType, length: number): EncodedVector {
    const bitWidth = reader.u8();
    const wordCount = reader.u32();
    const words = reader.typed(Uint32Array, wordCount);
    return new BitPackedVector(dataType, length, bitWidth, words);
  },
};
