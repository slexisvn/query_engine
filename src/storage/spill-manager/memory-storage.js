export class MemoryStorage {
  constructor() {
    this.store = new Map();
  }

  async append(partitionId, buffer) {
    if (!this.store.has(partitionId)) this.store.set(partitionId, []);
    this.store.get(partitionId).push(Buffer.from(buffer));
  }

  async read(partitionId) {
    const buffers = this.store.get(partitionId);
    if (!buffers || buffers.length === 0) return null;
    return Buffer.concat(buffers);
  }

  exists(partitionId) {
    const buffers = this.store.get(partitionId);
    return !!buffers && buffers.length > 0;
  }

  async remove(partitionId) {
    this.store.delete(partitionId);
  }

  async removeAll() {
    this.store.clear();
  }
}
