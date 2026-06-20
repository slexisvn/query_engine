const scratchF64 = new Float64Array(1);
const scratchU32 = new Uint32Array(scratchF64.buffer);

export function hashValue(value: string | number | bigint | boolean | null): number {
  if (typeof value === 'number') {
    scratchF64[0] = value;
    let h = scratchU32[0] ^ Math.imul(scratchU32[1], 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    return (h ^ (h >>> 13)) >>> 0;
  }
  if (typeof value === 'string') {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  if (typeof value === 'bigint') {
    return hashValue(Number(BigInt.asIntN(53, value)));
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return 0;
}
