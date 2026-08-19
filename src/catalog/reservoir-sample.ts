const MULBERRY_INCREMENT = 0x6d2b79f5;

export function deterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ReservoirSample<T> {
  readonly capacity: number;
  readonly items: T[];
  private seen: number;
  private readonly random: () => number;

  constructor(capacity: number, random: () => number) {
    this.capacity = Math.max(0, capacity);
    this.items = [];
    this.seen = 0;
    this.random = random;
  }

  get seenCount(): number {
    return this.seen;
  }

  offer(item: T): void {
    this.seen++;
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    if (this.capacity === 0) return;

    const index = Math.floor(this.random() * this.seen);
    if (index < this.capacity) this.items[index] = item;
  }
}
