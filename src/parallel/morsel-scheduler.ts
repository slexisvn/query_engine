import type { MorselSchedulerDescriptor, MorselRange } from './worker-messages.js';

export class MorselScheduler {
  totalUnits: number;
  unitsPerMorsel: number;
  counter: Int32Array;

  constructor(totalUnits: number, unitsPerMorsel: number) {
    this.totalUnits = totalUnits;
    this.unitsPerMorsel = Math.max(1, unitsPerMorsel | 0);
    this.counter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  }

  static attach({ counterBuffer, totalUnits, unitsPerMorsel }: MorselSchedulerDescriptor): MorselScheduler {
    const scheduler: MorselScheduler = Object.create(MorselScheduler.prototype);
    scheduler.totalUnits = totalUnits;
    scheduler.unitsPerMorsel = unitsPerMorsel;
    scheduler.counter = new Int32Array(counterBuffer);
    return scheduler;
  }

  descriptor(): MorselSchedulerDescriptor {
    return {
      counterBuffer: this.counter.buffer as SharedArrayBuffer,
      totalUnits: this.totalUnits,
      unitsPerMorsel: this.unitsPerMorsel,
    };
  }

  next(): MorselRange | null {
    const start = Atomics.add(this.counter, 0, this.unitsPerMorsel);
    if (start >= this.totalUnits) return null;
    return { start, end: Math.min(start + this.unitsPerMorsel, this.totalUnits) };
  }

  *drain(): Generator<MorselRange> {
    let morsel: MorselRange | null;
    while ((morsel = this.next()) !== null) {
      yield morsel;
    }
  }
}
