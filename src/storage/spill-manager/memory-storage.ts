import { concatBytes } from '../encoding/byte-io.js';
import type { SpillReader, SpillStorage } from './spill-manager.js';

const EMPTY_BYTES = new Uint8Array(0);

class BufferListSpillReader implements SpillReader {
  buffers: Uint8Array[];
  bufferIndex: number;
  offsetInBuffer: number;

  constructor(buffers: Uint8Array[]) {
    this.buffers = buffers;
    this.bufferIndex = 0;
    this.offsetInBuffer = 0;
  }

  async read(length: number): Promise<Uint8Array | null> {
    if (length === 0) return EMPTY_BYTES;

    const slices: Uint8Array[] = [];
    let remaining = length;

    while (remaining > 0) {
      const current = this.buffers[this.bufferIndex];
      if (!current) return null;

      const available = current.length - this.offsetInBuffer;
      if (available === 0) {
        this.bufferIndex++;
        this.offsetInBuffer = 0;
        continue;
      }

      const take = Math.min(available, remaining);
      slices.push(current.subarray(this.offsetInBuffer, this.offsetInBuffer + take));
      this.offsetInBuffer += take;
      remaining -= take;
    }

    return concatBytes(slices);
  }

  async close(): Promise<void> {
    this.buffers = [];
  }
}

export class MemoryStorage implements SpillStorage {
  store: Map<string, Uint8Array[]>;

  constructor() {
    this.store = new Map();
  }

  async append(partitionId: string, buffer: Uint8Array): Promise<void> {
    let buffers = this.store.get(partitionId);
    if (!buffers) {
      buffers = [];
      this.store.set(partitionId, buffers);
    }
    buffers.push(new Uint8Array(buffer));
  }

  async openReader(partitionId: string): Promise<SpillReader | null> {
    const buffers = this.store.get(partitionId);
    if (!buffers || buffers.length === 0) return null;
    return new BufferListSpillReader(buffers);
  }

  exists(partitionId: string): boolean {
    const buffers = this.store.get(partitionId);
    return !!buffers && buffers.length > 0;
  }

  async remove(partitionId: string): Promise<void> {
    this.store.delete(partitionId);
  }

  async removeAll(): Promise<void> {
    this.store.clear();
  }
}
