const TWO_POW_32 = 4294967296;

function alphaFor(registerCount: number): number {
  if (registerCount === 16) return 0.673;
  if (registerCount === 32) return 0.697;
  if (registerCount === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / registerCount);
}

export class HyperLogLog {
  readonly precision: number;
  readonly registers: Uint8Array;
  private readonly alpha: number;

  constructor(precision: number) {
    this.precision = precision;
    this.registers = new Uint8Array(1 << precision);
    this.alpha = alphaFor(this.registers.length);
  }

  addHash(hash: number): void {
    const index = hash >>> (32 - this.precision);
    const remainder = (hash << this.precision) >>> 0;
    const rank = remainder === 0 ? 33 - this.precision : Math.clz32(remainder) + 1;
    if (rank > this.registers[index]) this.registers[index] = rank;
  }

  estimate(): number {
    const m = this.registers.length;
    let harmonic = 0;
    let empty = 0;

    for (let i = 0; i < m; i++) {
      const rank = this.registers[i];
      if (rank === 0) empty++;
      harmonic += 1 / Math.pow(2, rank);
    }

    const raw = (this.alpha * m * m) / harmonic;

    if (raw <= 2.5 * m && empty > 0) return Math.round(m * Math.log(m / empty));
    if (raw > TWO_POW_32 / 30) return Math.round(-TWO_POW_32 * Math.log(1 - raw / TWO_POW_32));
    return Math.round(raw);
  }
}
