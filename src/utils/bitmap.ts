export function bitmapWordCount(length: number): number {
  return Math.ceil(length / 32);
}

export function createBitmap(length: number): Uint32Array {
  return new Uint32Array(bitmapWordCount(length));
}

export function setBit(bitmap: Uint32Array, index: number): void {
  bitmap[index >>> 5] |= (1 << (index & 31));
}

export function clearBit(bitmap: Uint32Array, index: number): void {
  bitmap[index >>> 5] &= ~(1 << (index & 31));
}

export function testBit(bitmap: Uint32Array, index: number): boolean {
  return (bitmap[index >>> 5] & (1 << (index & 31))) !== 0;
}

export function setBitRange(bitmap: Uint32Array, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    setBit(bitmap, i);
  }
}

export function andBitmaps(a: Uint32Array, b: Uint32Array, length: number): Uint32Array {
  const words = Math.ceil(length / 32);
  const result = new Uint32Array(words);
  for (let i = 0; i < words; i++) {
    result[i] = a[i] & b[i];
  }
  return result;
}

export function orBitmaps(a: Uint32Array, b: Uint32Array, length: number): Uint32Array {
  const words = Math.ceil(length / 32);
  const result = new Uint32Array(words);
  for (let i = 0; i < words; i++) {
    result[i] = a[i] | b[i];
  }
  return result;
}

export function notBitmap(bitmap: Uint32Array, length: number): Uint32Array {
  const words = Math.ceil(length / 32);
  const result = new Uint32Array(words);
  for (let i = 0; i < words; i++) {
    result[i] = ~bitmap[i];
  }
  const tailBits = length & 31;
  if (tailBits > 0) {
    result[words - 1] &= (1 << tailBits) - 1;
  }
  return result;
}

const POPCOUNT_TABLE: Uint8Array = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  POPCOUNT_TABLE[i] = POPCOUNT_TABLE[i >> 1] + (i & 1);
}

export function popcount(bitmap: Uint32Array, length: number): number {
  const words = Math.ceil(length / 32);
  let count = 0;
  for (let i = 0; i < words; i++) {
    let v = bitmap[i];
    count += POPCOUNT_TABLE[v & 0xff]
      + POPCOUNT_TABLE[(v >>> 8) & 0xff]
      + POPCOUNT_TABLE[(v >>> 16) & 0xff]
      + POPCOUNT_TABLE[(v >>> 24) & 0xff];
  }
  return count;
}

export function countSetBits(bitmap: Uint32Array, length: number): number {
  return popcount(bitmap, length);
}
