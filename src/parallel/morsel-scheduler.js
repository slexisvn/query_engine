export class MorselScheduler {
  constructor(totalUnits, unitsPerMorsel) {
    this.totalUnits = totalUnits;
    this.unitsPerMorsel = Math.max(1, unitsPerMorsel | 0);
    this.counter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  }

  static attach({ counterBuffer, totalUnits, unitsPerMorsel }) {
    const scheduler = Object.create(MorselScheduler.prototype);
    scheduler.totalUnits = totalUnits;
    scheduler.unitsPerMorsel = unitsPerMorsel;
    scheduler.counter = new Int32Array(counterBuffer);
    return scheduler;
  }

  descriptor() {
    return {
      counterBuffer: this.counter.buffer,
      totalUnits: this.totalUnits,
      unitsPerMorsel: this.unitsPerMorsel,
    };
  }

  next() {
    const start = Atomics.add(this.counter, 0, this.unitsPerMorsel);
    if (start >= this.totalUnits) return null;
    return { start, end: Math.min(start + this.unitsPerMorsel, this.totalUnits) };
  }

  *drain() {
    let morsel;
    while ((morsel = this.next()) !== null) {
      yield morsel;
    }
  }
}
