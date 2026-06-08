export function gatherSumI32(dataPtr: usize, svPtr: usize, svLen: i32): f64 {
  let total: i64 = 0;
  for (let i: i32 = 0; i < svLen; i++) {
    const idx = load<u32>(svPtr + (<usize>i << 2));
    total += <i64>load<i32>(dataPtr + (<usize>idx << 2));
  }
  return <f64>total;
}

export function gatherSumF64(dataPtr: usize, svPtr: usize, svLen: i32): f64 {
  let total: f64 = 0.0;
  for (let i: i32 = 0; i < svLen; i++) {
    const idx = load<u32>(svPtr + (<usize>i << 2));
    total += load<f64>(dataPtr + (<usize>idx << 3));
  }
  return total;
}

export function gatherMinI32(dataPtr: usize, svPtr: usize, svLen: i32): i32 {
  if (svLen <= 0) return 0;
  let result = load<i32>(dataPtr + (<usize>load<u32>(svPtr) << 2));
  for (let i: i32 = 1; i < svLen; i++) {
    const idx = load<u32>(svPtr + (<usize>i << 2));
    const v = load<i32>(dataPtr + (<usize>idx << 2));
    if (v < result) result = v;
  }
  return result;
}

export function gatherMaxI32(dataPtr: usize, svPtr: usize, svLen: i32): i32 {
  if (svLen <= 0) return 0;
  let result = load<i32>(dataPtr + (<usize>load<u32>(svPtr) << 2));
  for (let i: i32 = 1; i < svLen; i++) {
    const idx = load<u32>(svPtr + (<usize>i << 2));
    const v = load<i32>(dataPtr + (<usize>idx << 2));
    if (v > result) result = v;
  }
  return result;
}

export function gatherMinF64(dataPtr: usize, svPtr: usize, svLen: i32): f64 {
  if (svLen <= 0) return 0.0;
  let result = load<f64>(dataPtr + (<usize>load<u32>(svPtr) << 3));
  for (let i: i32 = 1; i < svLen; i++) {
    const idx = load<u32>(svPtr + (<usize>i << 2));
    const v = load<f64>(dataPtr + (<usize>idx << 3));
    if (v < result) result = v;
  }
  return result;
}

export function gatherMaxF64(dataPtr: usize, svPtr: usize, svLen: i32): f64 {
  if (svLen <= 0) return 0.0;
  let result = load<f64>(dataPtr + (<usize>load<u32>(svPtr) << 3));
  for (let i: i32 = 1; i < svLen; i++) {
    const idx = load<u32>(svPtr + (<usize>i << 2));
    const v = load<f64>(dataPtr + (<usize>idx << 3));
    if (v > result) result = v;
  }
  return result;
}

export function gatherCountI32(svLen: i32): i32 {
  return svLen;
}
