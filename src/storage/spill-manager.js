import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { ChunkSerializer } from './serializer.js';

export class FsStorage {
  constructor(basePath) {
    this.basePath = basePath;
  }

  filePath(partitionId) {
    return path.join(this.basePath, `${partitionId}.spill`);
  }

  async append(partitionId, buffer) {
    await fsPromises.appendFile(this.filePath(partitionId), buffer);
  }

  async read(partitionId) {
    const fp = this.filePath(partitionId);
    if (!fs.existsSync(fp)) return null;
    return fsPromises.readFile(fp);
  }

  exists(partitionId) {
    return fs.existsSync(this.filePath(partitionId));
  }

  async remove(partitionId) {
    const fp = this.filePath(partitionId);
    if (fs.existsSync(fp)) await fsPromises.unlink(fp);
  }

  async removeAll() {
    if (fs.existsSync(this.basePath)) {
      await fsPromises.rm(this.basePath, { recursive: true, force: true });
    }
  }
}

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

export class SpillManager {
  constructor(storage) {
    this.storage = storage;
  }

  async appendChunk(partitionId, chunk) {
    if (!chunk || chunk.size === 0) return;
    const data = ChunkSerializer.serialize(chunk);
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(data.length, 0);
    await this.storage.append(partitionId, Buffer.concat([header, data]));
  }

  async *readChunks(partitionId) {
    const fileBuffer = await this.storage.read(partitionId);
    if (!fileBuffer) return;

    let offset = 0;
    while (offset < fileBuffer.length) {
      const chunkLength = fileBuffer.readUInt32LE(offset);
      offset += 4;
      const chunkData = fileBuffer.subarray(offset, offset + chunkLength);
      yield ChunkSerializer.deserialize(chunkData);
      offset += chunkLength;
    }
  }

  async clearPartition(partitionId) {
    await this.storage.remove(partitionId);
  }

  async clearAll() {
    await this.storage.removeAll();
  }

  hasSpilled(partitionId) {
    return this.storage.exists(partitionId);
  }
}
