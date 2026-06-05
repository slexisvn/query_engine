export function filterEqF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  value: f64
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~1;
  const splat = f64x2.splat(value);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    const cmp = f64x2.eq(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<f64>(dataPtr + (<usize>i << 3)) == value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterLtF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  value: f64
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~1;
  const splat = f64x2.splat(value);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    const cmp = f64x2.lt(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<f64>(dataPtr + (<usize>i << 3)) < value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterGtF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  value: f64
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~1;
  const splat = f64x2.splat(value);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    const cmp = f64x2.gt(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<f64>(dataPtr + (<usize>i << 3)) > value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterLeF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  value: f64
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~1;
  const splat = f64x2.splat(value);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    const cmp = f64x2.le(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<f64>(dataPtr + (<usize>i << 3)) <= value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterGeF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  value: f64
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~1;
  const splat = f64x2.splat(value);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    const cmp = f64x2.ge(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<f64>(dataPtr + (<usize>i << 3)) >= value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterBetweenF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  low: f64,
  high: f64
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;

  const simdEnd = count & ~1;
  const splatLow = f64x2.splat(low);
  const splatHigh = f64x2.splat(high);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    const geqLow = f64x2.ge(vec, splatLow);
    const leqHigh = f64x2.le(vec, splatHigh);
    const cmp = v128.and(geqLow, leqHigh);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<f64>(dataPtr + (<usize>i << 3));
    if (v >= low && v <= high) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterLeI32(
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
    const cmp = i32x4.le_s(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<i32>(dataPtr + (<usize>i << 2)) <= value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterGeI32(
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
    const cmp = i32x4.ge_s(vec, splat);
    const mask = i8x16.bitmask(cmp);

    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    if (load<i32>(dataPtr + (<usize>i << 2)) >= value) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}
