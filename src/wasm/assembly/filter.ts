export function filterEqI32(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  value: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~3;
  const splat = i32x4.splat(value);

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const cmp = i32x4.eq(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<i32>(dataPtr + (<usize>i << 2)) == value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterLtI32(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  value: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~3;
  const splat = i32x4.splat(value);

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const cmp = i32x4.lt_s(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<i32>(dataPtr + (<usize>i << 2)) < value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterGtI32(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  value: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~3;
  const splat = i32x4.splat(value);

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const cmp = i32x4.gt_s(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<i32>(dataPtr + (<usize>i << 2)) > value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterBetweenI32(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  low: i32,
  high: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~3;
  const splatLow = i32x4.splat(low);
  const splatHigh = i32x4.splat(high);

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const geqLow = i32x4.ge_s(vec, splatLow);
    const leqHigh = i32x4.le_s(vec, splatHigh);
    const cmp = v128.and(geqLow, leqHigh);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<i32>(dataPtr + (<usize>i << 2));
    if (v >= low && v <= high) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
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

export function countNonNullI32(dataPtr: usize, count: i32, nullValue: i32): i32 {
  let result: i32 = 0;
  const splat = i32x4.splat(nullValue);
  let i: i32 = 0;

  const simdEnd = count & ~3;
  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const cmp = i32x4.ne(vec, splat);
    const mask = i8x16.bitmask(cmp);
    if (mask & 0x000F) result++;
    if (mask & 0x00F0) result++;
    if (mask & 0x0F00) result++;
    if (mask & 0xF000) result++;
  }

  for (; i < count; i++) {
    if (load<i32>(dataPtr + (<usize>i << 2)) != nullValue) result++;
  }

  return result;
}
