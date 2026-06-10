import { Config } from '../config.js';

const BASE_ALIGNMENT = 8;

export class HeapAllocator {
  get shared() {
    return false;
  }

  acquire(Ctor, length) {
    return new Ctor(length);
  }
}

export const heapAllocator = new HeapAllocator();

export class SabArena {
  constructor(initialBytes = Config.sabArenaSegmentBytes) {
    this.nextSegmentBytes = Math.max(BASE_ALIGNMENT, initialBytes | 0);
    this.segments = [];
  }

  get shared() {
    return true;
  }

  acquire(Ctor, length) {
    const byteLength = length * Ctor.BYTES_PER_ELEMENT;
    const alignment = Math.max(Ctor.BYTES_PER_ELEMENT, BASE_ALIGNMENT);
    const segment = this._segmentFor(byteLength, alignment);
    const offset = (segment.offset + alignment - 1) & ~(alignment - 1);
    segment.offset = offset + byteLength;
    return new Ctor(segment.sab, offset, length);
  }

  _segmentFor(byteLength, alignment) {
    const last = this.segments[this.segments.length - 1];
    if (last) {
      const aligned = (last.offset + alignment - 1) & ~(alignment - 1);
      if (aligned + byteLength <= last.sab.byteLength) return last;
    }
    const size = Math.max(this.nextSegmentBytes, byteLength + alignment);
    this.nextSegmentBytes = size * 2;
    const segment = { sab: new SharedArrayBuffer(size), offset: 0 };
    this.segments.push(segment);
    return segment;
  }

  totalBytes() {
    let total = 0;
    for (const segment of this.segments) total += segment.sab.byteLength;
    return total;
  }
}

export function columnAllocator(byteHint = 0) {
  if (!Config.sabColumns) return heapAllocator;
  return byteHint > 0 ? new SabArena(byteHint) : new SabArena();
}

export function isSharedView(view) {
  return !!view && view.buffer instanceof SharedArrayBuffer;
}
