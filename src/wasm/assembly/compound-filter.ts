const CMP_EQ: i32 = 0;
const CMP_LT: i32 = 1;
const CMP_GT: i32 = 2;
const CMP_LE: i32 = 3;
const CMP_GE: i32 = 4;

// @ts-ignore: decorator
@inline
function simdCmpI32(vec: v128, splat: v128, op: i32): v128 {
  if (op == CMP_EQ) return i32x4.eq(vec, splat);
  if (op == CMP_LT) return i32x4.lt_s(vec, splat);
  if (op == CMP_GT) return i32x4.gt_s(vec, splat);
  if (op == CMP_LE) return i32x4.le_s(vec, splat);
  return i32x4.ge_s(vec, splat);
}

// @ts-ignore: decorator
@inline
function scalarCmpI32(v: i32, val: i32, op: i32): bool {
  if (op == CMP_EQ) return v == val;
  if (op == CMP_LT) return v < val;
  if (op == CMP_GT) return v > val;
  if (op == CMP_LE) return v <= val;
  return v >= val;
}

// @ts-ignore: decorator
@inline
function simdCmpF64(vec: v128, splat: v128, op: i32): v128 {
  if (op == CMP_EQ) return f64x2.eq(vec, splat);
  if (op == CMP_LT) return f64x2.lt(vec, splat);
  if (op == CMP_GT) return f64x2.gt(vec, splat);
  if (op == CMP_LE) return f64x2.le(vec, splat);
  return f64x2.ge(vec, splat);
}

// @ts-ignore: decorator
@inline
function scalarCmpF64(v: f64, val: f64, op: i32): bool {
  if (op == CMP_EQ) return v == val;
  if (op == CMP_LT) return v < val;
  if (op == CMP_GT) return v > val;
  if (op == CMP_LE) return v <= val;
  return v >= val;
}

export function filterCompoundAndI32(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  op1: i32, val1: i32,
  op2: i32, val2: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;
  const simdEnd = count & ~3;
  const splat1 = i32x4.splat(val1);
  const splat2 = i32x4.splat(val2);

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const cmp = v128.and(simdCmpI32(vec, splat1, op1), simdCmpI32(vec, splat2, op2));
    const mask = i8x16.bitmask(cmp);

    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<i32>(dataPtr + (<usize>i << 2));
    if (scalarCmpI32(v, val1, op1) && scalarCmpI32(v, val2, op2)) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterCompoundOrI32(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  op1: i32, val1: i32,
  op2: i32, val2: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;
  const simdEnd = count & ~3;
  const splat1 = i32x4.splat(val1);
  const splat2 = i32x4.splat(val2);

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    const cmp = v128.or(simdCmpI32(vec, splat1, op1), simdCmpI32(vec, splat2, op2));
    const mask = i8x16.bitmask(cmp);

    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<i32>(dataPtr + (<usize>i << 2));
    if (scalarCmpI32(v, val1, op1) || scalarCmpI32(v, val2, op2)) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterCompoundAndF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  op1: i32, val1: f64,
  op2: i32, val2: f64
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const splat1 = f64x2.splat(val1);
  const splat2 = f64x2.splat(val2);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    const cmp = v128.and(simdCmpF64(vec, splat1, op1), simdCmpF64(vec, splat2, op2));
    const mask = i8x16.bitmask(cmp);

    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<f64>(dataPtr + (<usize>i << 3));
    if (scalarCmpF64(v, val1, op1) && scalarCmpF64(v, val2, op2)) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterCompoundOrF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  op1: i32, val1: f64,
  op2: i32, val2: f64
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const splat1 = f64x2.splat(val1);
  const splat2 = f64x2.splat(val2);

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    const cmp = v128.or(simdCmpF64(vec, splat1, op1), simdCmpF64(vec, splat2, op2));
    const mask = i8x16.bitmask(cmp);

    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<f64>(dataPtr + (<usize>i << 3));
    if (scalarCmpF64(v, val1, op1) || scalarCmpF64(v, val2, op2)) {
      store<i32>(selVecPtr + (<usize>matchCount << 2), i);
      matchCount++;
    }
  }

  return matchCount;
}

export function filterCompoundAndNI32(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  opsPtr: usize,
  valsPtr: usize,
  predCount: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;
  const simdEnd = count & ~3;

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    let acc = i32x4.splat(-1);
    for (let p: i32 = 0; p < predCount; p++) {
      const op = load<i32>(opsPtr + (<usize>p << 2));
      acc = v128.and(acc, simdCmpI32(vec, i32x4.splat(load<i32>(valsPtr + (<usize>p << 2))), op));
    }
    const mask = i8x16.bitmask(acc);
    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<i32>(dataPtr + (<usize>i << 2));
    let pass: bool = true;
    for (let p: i32 = 0; p < predCount; p++) {
      if (!scalarCmpI32(v, load<i32>(valsPtr + (<usize>p << 2)), load<i32>(opsPtr + (<usize>p << 2)))) {
        pass = false;
        break;
      }
    }
    if (pass) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
  }

  return matchCount;
}

export function filterCompoundOrNI32(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  opsPtr: usize,
  valsPtr: usize,
  predCount: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;
  const simdEnd = count & ~3;

  for (; i < simdEnd; i += 4) {
    const vec = v128.load(dataPtr + (<usize>i << 2));
    let acc = i32x4.splat(0);
    for (let p: i32 = 0; p < predCount; p++) {
      const op = load<i32>(opsPtr + (<usize>p << 2));
      acc = v128.or(acc, simdCmpI32(vec, i32x4.splat(load<i32>(valsPtr + (<usize>p << 2))), op));
    }
    const mask = i8x16.bitmask(acc);
    if (mask & 0x000F) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0x00F0) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
    if (mask & 0x0F00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 2); matchCount++; }
    if (mask & 0xF000) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 3); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<i32>(dataPtr + (<usize>i << 2));
    let pass: bool = false;
    for (let p: i32 = 0; p < predCount; p++) {
      if (scalarCmpI32(v, load<i32>(valsPtr + (<usize>p << 2)), load<i32>(opsPtr + (<usize>p << 2)))) {
        pass = true;
        break;
      }
    }
    if (pass) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
  }

  return matchCount;
}

export function filterCompoundAndNF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  opsPtr: usize,
  valsPtr: usize,
  predCount: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;
  const simdEnd = count & ~1;

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    let acc = i32x4.splat(-1);
    for (let p: i32 = 0; p < predCount; p++) {
      const op = load<i32>(opsPtr + (<usize>p << 2));
      acc = v128.and(acc, simdCmpF64(vec, f64x2.splat(load<f64>(valsPtr + (<usize>p << 3))), op));
    }
    const mask = i8x16.bitmask(acc);
    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<f64>(dataPtr + (<usize>i << 3));
    let pass: bool = true;
    for (let p: i32 = 0; p < predCount; p++) {
      if (!scalarCmpF64(v, load<f64>(valsPtr + (<usize>p << 3)), load<i32>(opsPtr + (<usize>p << 2)))) {
        pass = false;
        break;
      }
    }
    if (pass) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
  }

  return matchCount;
}

export function filterCompoundOrNF64(
  dataPtr: usize,
  selVecPtr: usize,
  count: i32,
  opsPtr: usize,
  valsPtr: usize,
  predCount: i32
): i32 {
  let matchCount: i32 = 0;
  let i: i32 = 0;
  const simdEnd = count & ~1;

  for (; i < simdEnd; i += 2) {
    const vec = v128.load(dataPtr + (<usize>i << 3));
    let acc = i32x4.splat(0);
    for (let p: i32 = 0; p < predCount; p++) {
      const op = load<i32>(opsPtr + (<usize>p << 2));
      acc = v128.or(acc, simdCmpF64(vec, f64x2.splat(load<f64>(valsPtr + (<usize>p << 3))), op));
    }
    const mask = i8x16.bitmask(acc);
    if (mask & 0xFF) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
    if (mask & 0xFF00) { store<i32>(selVecPtr + (<usize>matchCount << 2), i + 1); matchCount++; }
  }

  for (; i < count; i++) {
    const v = load<f64>(dataPtr + (<usize>i << 3));
    let pass: bool = false;
    for (let p: i32 = 0; p < predCount; p++) {
      if (scalarCmpF64(v, load<f64>(valsPtr + (<usize>p << 3)), load<i32>(opsPtr + (<usize>p << 2)))) {
        pass = true;
        break;
      }
    }
    if (pass) { store<i32>(selVecPtr + (<usize>matchCount << 2), i); matchCount++; }
  }

  return matchCount;
}
