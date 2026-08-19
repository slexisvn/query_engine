import { hashValue } from './hash.js';
import type { ColumnValue } from '../storage/data-type.js';

const BITS_PER_WORD = 32;
const SECOND_HASH_MIX = 0x27d4eb2d;
const MIN_BITS = BITS_PER_WORD;
const LN2 = Math.LN2;
const LN2_SQUARED = LN2 * LN2;

export function bloomBitCount(expectedEntries: number, falsePositiveRate: number): number {
  if (expectedEntries <= 0) return MIN_BITS;
  const bits = Math.ceil(-(expectedEntries * Math.log(falsePositiveRate)) / LN2_SQUARED);
  return Math.max(MIN_BITS, bits);
}

export function bloomHashCount(bitCount: number, expectedEntries: number): number {
  if (expectedEntries <= 0) return 1;
  return Math.max(1, Math.round((bitCount / expectedEntries) * LN2));
}

export class BloomFilter {
  bits: Uint32Array;
  bitCount: number;
  hashCount: number;
  insertedCount: number;

  constructor(expectedEntries: number, falsePositiveRate: number) {
    this.bitCount = bloomBitCount(expectedEntries, falsePositiveRate);
    this.hashCount = bloomHashCount(this.bitCount, expectedEntries);
    this.bits = new Uint32Array(Math.ceil(this.bitCount / BITS_PER_WORD));
    this.insertedCount = 0;
  }

  add(value: ColumnValue): void {
    const primary = hashValue(value);
    const secondary = (Math.imul(primary ^ (primary >>> 15), SECOND_HASH_MIX) >>> 0) | 1;

    for (let i = 0; i < this.hashCount; i++) {
      const bit = (primary + Math.imul(i, secondary)) >>> 0;
      const index = bit % this.bitCount;
      this.bits[index >>> 5] |= 1 << (index & 31);
    }

    this.insertedCount++;
  }

  mightContain(value: ColumnValue): boolean {
    const primary = hashValue(value);
    const secondary = (Math.imul(primary ^ (primary >>> 15), SECOND_HASH_MIX) >>> 0) | 1;

    for (let i = 0; i < this.hashCount; i++) {
      const bit = (primary + Math.imul(i, secondary)) >>> 0;
      const index = bit % this.bitCount;
      if ((this.bits[index >>> 5] & (1 << (index & 31))) === 0) return false;
    }

    return true;
  }

  get byteSize(): number {
    return this.bits.byteLength;
  }

  get saturation(): number {
    let set = 0;
    for (let word = 0; word < this.bits.length; word++) {
      let value = this.bits[word];
      while (value !== 0) {
        set += value & 1;
        value >>>= 1;
      }
    }
    return set / this.bitCount;
  }
}
