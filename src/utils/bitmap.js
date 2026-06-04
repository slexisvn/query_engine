export function createBitmap(length) {
  return new Uint32Array(Math.ceil(length / 32));
}

export function setBit(bitmap, index) {
  bitmap[index >>> 5] |= (1 << (index & 31));
}

export function clearBit(bitmap, index) {
  bitmap[index >>> 5] &= ~(1 << (index & 31));
}

export function testBit(bitmap, index) {
  return (bitmap[index >>> 5] & (1 << (index & 31))) !== 0;
}

export function setBitRange(bitmap, start, end) {
  for (let i = start; i < end; i++) {
    setBit(bitmap, i);
  }
}

export function andBitmaps(a, b, length) {
  const words = Math.ceil(length / 32);
  const result = new Uint32Array(words);
  for (let i = 0; i < words; i++) {
    result[i] = a[i] & b[i];
  }
  return result;
}

export function orBitmaps(a, b, length) {
  const words = Math.ceil(length / 32);
  const result = new Uint32Array(words);
  for (let i = 0; i < words; i++) {
    result[i] = a[i] | b[i];
  }
  return result;
}

export function notBitmap(bitmap, length) {
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

const POPCOUNT_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  POPCOUNT_TABLE[i] = POPCOUNT_TABLE[i >> 1] + (i & 1);
}

export function popcount(bitmap, length) {
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

export function countSetBits(bitmap, length) {
  return popcount(bitmap, length);
}
