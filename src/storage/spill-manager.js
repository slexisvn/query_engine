import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { ChunkSerializer } from './serializer.js';

export class SpillManager {
  constructor(basePath) {
    this.storageDir = basePath;
  }

  getFilePath(partitionId) {
    return path.join(this.storageDir, `${partitionId}.spill`);
  }

  async appendChunk(partitionId, chunk) {
    if (!chunk || chunk.size === 0) return;
    const data = ChunkSerializer.serialize(chunk);
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(data.length, 0);
    await fsPromises.appendFile(this.getFilePath(partitionId), Buffer.concat([header, data]));
  }

  async *readChunks(partitionId) {
    const filePath = this.getFilePath(partitionId);
    if (!fs.existsSync(filePath)) {
      return;
    }

    const fileBuffer = await fsPromises.readFile(filePath);
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
    const filePath = this.getFilePath(partitionId);
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath);
    }
  }

  async clearAll() {
    if (fs.existsSync(this.storageDir)) {
      await fsPromises.rm(this.storageDir, { recursive: true, force: true });
    }
  }

  hasSpilled(partitionId) {
    return fs.existsSync(this.getFilePath(partitionId));
  }
}
