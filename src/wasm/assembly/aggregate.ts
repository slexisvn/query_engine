export function sumI32(dataPtr: usize, count: i32): f64 {
  let i: i32 = 0;
  const simdEnd = count & ~3;
  let accumLo: i64 = 0;
  let accumHi: i64 = 0;

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    accumLo += <i64>i32x4.extract_lane(vec, 0) + <i64>i32x4.extract_lane(vec, 1);
    accumHi += <i64>i32x4.extract_lane(vec, 2) + <i64>i32x4.extract_lane(vec, 3);
  }

  let total: i64 = accumLo + accumHi;

  for (; i < count; i++) {
    total += <i64>load<i32>(dataPtr + (<usize>i << 2));
  }

  return <f64>total;
}

export function sumF64(dataPtr: usize, count: i32): f64 {
  let sum: f64 = 0.0;
  let i: i32 = 0;

  const simdEnd = count & ~1;
  let accumVec = f64x2.splat(0.0);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    accumVec = f64x2.add(accumVec, vec);
  }

  sum = f64x2.extract_lane(accumVec, 0) + f64x2.extract_lane(accumVec, 1);

  for (; i < count; i++) {
    sum += load<f64>(dataPtr + (<usize>i << 3));
  }

  return sum;
}

export function minI32(dataPtr: usize, count: i32): i32 {
  if (count <= 0) return 0;

  let i: i32 = 0;
  const simdEnd = count & ~3;

  let minVec = i32x4.splat(i32.MAX_VALUE);

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const cmp = i32x4.lt_s(vec, minVec);
    minVec = v128.bitselect(vec, minVec, cmp);
  }

  let result = i32x4.extract_lane(minVec, 0);
  let lane1 = i32x4.extract_lane(minVec, 1);
  let lane2 = i32x4.extract_lane(minVec, 2);
  let lane3 = i32x4.extract_lane(minVec, 3);
  if (lane1 < result) result = lane1;
  if (lane2 < result) result = lane2;
  if (lane3 < result) result = lane3;

  for (; i < count; i++) {
    const v = load<i32>(dataPtr + (<usize>i << 2));
    if (v < result) result = v;
  }

  return result;
}

export function maxI32(dataPtr: usize, count: i32): i32 {
  if (count <= 0) return 0;

  let i: i32 = 0;
  const simdEnd = count & ~3;

  let maxVec = i32x4.splat(i32.MIN_VALUE);

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const cmp = i32x4.gt_s(vec, maxVec);
    maxVec = v128.bitselect(vec, maxVec, cmp);
  }

  let result = i32x4.extract_lane(maxVec, 0);
  let lane1 = i32x4.extract_lane(maxVec, 1);
  let lane2 = i32x4.extract_lane(maxVec, 2);
  let lane3 = i32x4.extract_lane(maxVec, 3);
  if (lane1 > result) result = lane1;
  if (lane2 > result) result = lane2;
  if (lane3 > result) result = lane3;

  for (; i < count; i++) {
    const v = load<i32>(dataPtr + (<usize>i << 2));
    if (v > result) result = v;
  }

  return result;
}

export function minF64(dataPtr: usize, count: i32): f64 {
  if (count <= 0) return 0.0;

  let i: i32 = 0;
  const simdEnd = count & ~1;

  let minVec = f64x2.splat(f64.MAX_VALUE);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    minVec = f64x2.min(minVec, vec);
  }

  let result = f64x2.extract_lane(minVec, 0);
  let lane1 = f64x2.extract_lane(minVec, 1);
  if (lane1 < result) result = lane1;

  for (; i < count; i++) {
    const v = load<f64>(dataPtr + (<usize>i << 3));
    if (v < result) result = v;
  }

  return result;
}

export function maxF64(dataPtr: usize, count: i32): f64 {
  if (count <= 0) return 0.0;

  let i: i32 = 0;
  const simdEnd = count & ~1;

  let maxVec = f64x2.splat(-f64.MAX_VALUE);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    maxVec = f64x2.max(maxVec, vec);
  }

  let result = f64x2.extract_lane(maxVec, 0);
  let lane1 = f64x2.extract_lane(maxVec, 1);
  if (lane1 > result) result = lane1;

  for (; i < count; i++) {
    const v = load<f64>(dataPtr + (<usize>i << 3));
    if (v > result) result = v;
  }

  return result;
}

export function countBits(bitmapPtr: usize, wordCount: i32): i32 {
  let total: i32 = 0;

  for (let i: i32 = 0; i < wordCount; i++) {
    let word = load<u32>(bitmapPtr + (<usize>i << 2));
    word = word - ((word >> 1) & 0x55555555);
    word = (word & 0x33333333) + ((word >> 2) & 0x33333333);
    word = (word + (word >> 4)) & 0x0F0F0F0F;
    total += <i32>((word * 0x01010101) >> 24);
  }

  return total;
}

export function countBitmapBits(bitmapPtr: usize, count: i32): i32 {
  let total: i32 = 0;
  const fullWords = count >> 5;

  for (let i: i32 = 0; i < fullWords; i++) {
    let word = load<u32>(bitmapPtr + (<usize>i << 2));
    word = word - ((word >> 1) & 0x55555555);
    word = (word & 0x33333333) + ((word >> 2) & 0x33333333);
    word = (word + (word >> 4)) & 0x0F0F0F0F;
    total += <i32>((word * 0x01010101) >> 24);
  }

  const remainder = count & 31;
  if (remainder > 0) {
    let word = load<u32>(bitmapPtr + (<usize>fullWords << 2));
    word = word & ((<u32>1 << remainder) - 1);
    word = word - ((word >> 1) & 0x55555555);
    word = (word & 0x33333333) + ((word >> 2) & 0x33333333);
    word = (word + (word >> 4)) & 0x0F0F0F0F;
    total += <i32>((word * 0x01010101) >> 24);
  }

  return total;
}
