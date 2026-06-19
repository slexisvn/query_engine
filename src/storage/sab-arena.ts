import { Config } from '../config.js';
import type { AnyTypedArray, TypedArrayCtor } from './data-type.js';

const BASE_ALIGNMENT = 8;

export interface Allocator {
  readonly shared: boolean;
  acquire<T extends AnyTypedArray>(Ctor: TypedArrayCtor<T>, length: number): T;
}

interface ArenaSegment {
  sab: SharedArrayBuffer;
  offset: number;
}

export class HeapAllocator implements Allocator {
  get shared(): boolean {
    return false;
  }

  acquire<T extends AnyTypedArray>(Ctor: TypedArrayCtor<T>, length: number): T {
    return new Ctor(length);
  }
}

export const heapAllocator = new HeapAllocator();

export class SabArena implements Allocator {
  nextSegmentBytes: number;
  segments: ArenaSegment[];

  constructor(initialBytes: number = Config.sabArenaSegmentBytes) {
    this.nextSegmentBytes = Math.max(BASE_ALIGNMENT, initialBytes | 0);
    this.segments = [];
  }

  get shared(): boolean {
    return true;
  }

  acquire<T extends AnyTypedArray>(Ctor: TypedArrayCtor<T>, length: number): T {
    const byteLength = length * Ctor.BYTES_PER_ELEMENT;
    const alignment = Math.max(Ctor.BYTES_PER_ELEMENT, BASE_ALIGNMENT);
    const segment = this._segmentFor(byteLength, alignment);
    const offset = (segment.offset + alignment - 1) & ~(alignment - 1);
    segment.offset = offset + byteLength;
    return new Ctor(segment.sab, offset, length);
  }

  _segmentFor(byteLength: number, alignment: number): ArenaSegment {
    const last = this.segments[this.segments.length - 1];
    if (last) {
      const aligned = (last.offset + alignment - 1) & ~(alignment - 1);
      if (aligned + byteLength <= last.sab.byteLength) return last;
    }
    const size = Math.max(this.nextSegmentBytes, byteLength + alignment);
    this.nextSegmentBytes = size * 2;
    const segment: ArenaSegment = { sab: new SharedArrayBuffer(size), offset: 0 };
    this.segments.push(segment);
    return segment;
  }

  totalBytes(): number {
    let total = 0;
    for (const segment of this.segments) total += segment.sab.byteLength;
    return total;
  }
}

export function columnAllocator(byteHint = 0): Allocator {
  if (!Config.sabColumns) return heapAllocator;
  return byteHint > 0 ? new SabArena(byteHint) : new SabArena();
}

export function isSharedView(view: ArrayBufferView | null | undefined): boolean {
  return !!view && view.buffer instanceof SharedArrayBuffer;
}
