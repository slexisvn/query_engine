import { ChunkSerializer } from '../serializer.js';

const LENGTH_HEADER_BYTES = 4;

export class SpillManager {
  constructor(storage) {
    this.storage = storage;
  }

  async appendChunk(partitionId, chunk) {
    if (!chunk || chunk.size === 0) return;
    const data = ChunkSerializer.serialize(chunk);
    const header = Buffer.allocUnsafe(LENGTH_HEADER_BYTES);
    header.writeUInt32LE(data.length, 0);
    await this.storage.append(partitionId, Buffer.concat([header, data]));
  }

  async *readChunks(partitionId) {
    const fileBuffer = await this.storage.read(partitionId);
    if (!fileBuffer) return;

    let offset = 0;
    while (offset < fileBuffer.length) {
      const chunkLength = fileBuffer.readUInt32LE(offset);
      offset += LENGTH_HEADER_BYTES;
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
