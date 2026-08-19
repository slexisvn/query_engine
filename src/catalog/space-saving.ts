export interface FrequentItem {
  value: string;
  count: number;
}

export class SpaceSavingCounter {
  readonly capacity: number;
  private readonly positions: Map<string, number>;
  private readonly values: string[];
  private readonly counts: number[];
  private observed: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.positions = new Map();
    this.values = [];
    this.counts = [];
    this.observed = 0;
  }

  get totalObserved(): number {
    return this.observed;
  }

  add(value: string): void {
    this.observed++;

    const existing = this.positions.get(value);
    if (existing !== undefined) {
      this.counts[existing]++;
      this.siftDown(existing);
      return;
    }

    if (this.values.length < this.capacity) {
      this.values.push(value);
      this.counts.push(1);
      this.positions.set(value, this.values.length - 1);
      this.siftUp(this.values.length - 1);
      return;
    }

    this.positions.delete(this.values[0]);
    this.values[0] = value;
    this.counts[0]++;
    this.positions.set(value, 0);
    this.siftDown(0);
  }

  top(k: number): FrequentItem[] {
    return this.values
      .map((value, i) => ({ value, count: this.counts[i] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, k);
  }

  private swap(a: number, b: number): void {
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
    [this.counts[a], this.counts[b]] = [this.counts[b], this.counts[a]];
    this.positions.set(this.values[a], a);
    this.positions.set(this.values[b], b);
  }

  private siftUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (this.counts[parent] <= this.counts[current]) break;
      this.swap(parent, current);
      current = parent;
    }
  }

  private siftDown(index: number): void {
    const size = this.counts.length;
    let current = index;
    for (;;) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;
      if (left < size && this.counts[left] < this.counts[smallest]) smallest = left;
      if (right < size && this.counts[right] < this.counts[smallest]) smallest = right;
      if (smallest === current) return;
      this.swap(smallest, current);
      current = smallest;
    }
  }
}
