import type { SpillStorage } from './spill-manager.js';

export class MemoryStorage implements SpillStorage {
  store: Map<string, Buffer[]>;

  constructor() {
    this.store = new Map();
  }

  async append(partitionId: string, buffer: Buffer): Promise<void> {
    if (!this.store.has(partitionId)) this.store.set(partitionId, []);
    this.store.get(partitionId)!.push(Buffer.from(buffer));
  }

  async read(partitionId: string): Promise<Buffer | null> {
    const buffers = this.store.get(partitionId);
    if (!buffers || buffers.length === 0) return null;
    return Buffer.concat(buffers);
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
