export function vecAddF64(aPtr: usize, bPtr: usize, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const a = v128.load(aPtr + offset);
    const b = v128.load(bPtr + offset);
    v128.store(outPtr + offset, f64x2.add(a, b));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, load<f64>(aPtr + offset) + load<f64>(bPtr + offset));
  }
}

export function vecSubF64(aPtr: usize, bPtr: usize, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const a = v128.load(aPtr + offset);
    const b = v128.load(bPtr + offset);
    v128.store(outPtr + offset, f64x2.sub(a, b));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, load<f64>(aPtr + offset) - load<f64>(bPtr + offset));
  }
}

export function vecMulF64(aPtr: usize, bPtr: usize, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const a = v128.load(aPtr + offset);
    const b = v128.load(bPtr + offset);
    v128.store(outPtr + offset, f64x2.mul(a, b));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, load<f64>(aPtr + offset) * load<f64>(bPtr + offset));
  }
}

export function vecDivF64(aPtr: usize, bPtr: usize, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const a = v128.load(aPtr + offset);
    const b = v128.load(bPtr + offset);
    v128.store(outPtr + offset, f64x2.div(a, b));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, load<f64>(aPtr + offset) / load<f64>(bPtr + offset));
  }
}

export function scalarAddF64(dataPtr: usize, scalar: f64, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const splat = f64x2.splat(scalar);

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const vec = v128.load(dataPtr + offset);
    v128.store(outPtr + offset, f64x2.add(vec, splat));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, load<f64>(dataPtr + offset) + scalar);
  }
}

export function scalarSubF64(dataPtr: usize, scalar: f64, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const splat = f64x2.splat(scalar);

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const vec = v128.load(dataPtr + offset);
    v128.store(outPtr + offset, f64x2.sub(vec, splat));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, load<f64>(dataPtr + offset) - scalar);
  }
}

export function scalarMulF64(dataPtr: usize, scalar: f64, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const splat = f64x2.splat(scalar);

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const vec = v128.load(dataPtr + offset);
    v128.store(outPtr + offset, f64x2.mul(vec, splat));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, load<f64>(dataPtr + offset) * scalar);
  }
}

export function scalarDivF64(dataPtr: usize, scalar: f64, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const splat = f64x2.splat(scalar);

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const vec = v128.load(dataPtr + offset);
    v128.store(outPtr + offset, f64x2.div(vec, splat));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, load<f64>(dataPtr + offset) / scalar);
  }
}

export function scalarSubRevF64(scalar: f64, dataPtr: usize, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const splat = f64x2.splat(scalar);

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const vec = v128.load(dataPtr + offset);
    v128.store(outPtr + offset, f64x2.sub(splat, vec));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, scalar - load<f64>(dataPtr + offset));
  }
}

export function scalarDivRevF64(scalar: f64, dataPtr: usize, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const splat = f64x2.splat(scalar);

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const vec = v128.load(dataPtr + offset);
    v128.store(outPtr + offset, f64x2.div(splat, vec));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, scalar / load<f64>(dataPtr + offset));
  }
}

export function widenI32ToF64(dataPtr: usize, outPtr: usize, count: i32): void {
  for (let i: i32 = 0; i < count; i++) {
    store<f64>(outPtr + (<usize>i << 3), <f64>load<i32>(dataPtr + (<usize>i << 2)));
  }
}

export function negF64(dataPtr: usize, outPtr: usize, count: i32): void {
  let i: i32 = 0;
  const simdEnd = count & ~1;
  const zero = f64x2.splat(0.0);

  for (; i < simdEnd; i += 2) {
    const offset = <usize>i << 3;
    const vec = v128.load(dataPtr + offset);
    v128.store(outPtr + offset, f64x2.sub(zero, vec));
  }

  for (; i < count; i++) {
    const offset = <usize>i << 3;
    store<f64>(outPtr + offset, -load<f64>(dataPtr + offset));
  }
}
