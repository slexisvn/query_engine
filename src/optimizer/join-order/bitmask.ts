export const BITMASK_RELATION_CAPACITY = 30;

export function lowestBitIndex(mask: number): number {
  return 31 - Math.clz32(mask & -mask);
}

export function* bitIndices(mask: number): Generator<number> {
  let remaining = mask;
  while (remaining !== 0) {
    const bit = remaining & -remaining;
    yield 31 - Math.clz32(bit);
    remaining ^= bit;
  }
}

export function popcount(mask: number): number {
  let m = mask - ((mask >> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >> 2) & 0x33333333);
  m = (m + (m >> 4)) & 0x0f0f0f0f;
  return (m * 0x01010101) >> 24;
}

export function subsets(mask: number): number[] {
  const result: number[] = [];
  let s = mask;
  while (s > 0) {
    result.push(s);
    s = (s - 1) & mask;
  }
  return result;
}

export function descendingBitIndices(mask: number): number[] {
  const indices = [...bitIndices(mask)];
  indices.reverse();
  return indices;
}

export function subsetsByAscendingSize(mask: number): number[] {
  const width = popcount(mask);
  const counts = new Int32Array(width + 2);
  let total = 0;
  for (let subset = mask; subset > 0; subset = (subset - 1) & mask) {
    counts[popcount(subset)]++;
    total++;
  }

  const cursor = new Int32Array(width + 2);
  for (let size = 2; size <= width; size++) cursor[size] = cursor[size - 1] + counts[size - 1];

  const ordered = new Array<number>(total);
  for (let subset = mask; subset > 0; subset = (subset - 1) & mask) {
    ordered[cursor[popcount(subset)]++] = subset;
  }
  return ordered;
}

export function maskBelowOrEqual(index: number): number {
  return (1 << (index + 1)) - 1;
}
