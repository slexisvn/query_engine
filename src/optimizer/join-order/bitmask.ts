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
  const buckets: number[][] = Array.from({ length: width + 1 }, () => []);
  for (const subset of subsets(mask)) buckets[popcount(subset)].push(subset);

  const ordered: number[] = [];
  for (let size = 1; size <= width; size++) {
    for (const subset of buckets[size]) ordered.push(subset);
  }
  return ordered;
}

export function maskBelowOrEqual(index: number): number {
  return (1 << (index + 1)) - 1;
}
