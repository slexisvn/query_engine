import { ChunkSerializer } from '../serializer.js';
import type { DataChunk } from '../chunk.js';

export interface SpillStorage {
  append(partitionId: string, buffer: Buffer): Promise<void>;
  read(partitionId: string): Promise<Buffer | null>;
  exists(partitionId: string): boolean;
  remove(partitionId: string): Promise<void>;
  removeAll(): Promise<void>;
}

const LENGTH_HEADER_BYTES = 4;

export class SpillManager {
  storage: SpillStorage;

  constructor(storage: SpillStorage) {
    this.storage = storage;
  }

  async appendChunk(partitionId: string, chunk: DataChunk | null): Promise<void> {
    if (!chunk || chunk.size === 0) return;
    const data = ChunkSerializer.serialize(chunk);
    const header = Buffer.allocUnsafe(LENGTH_HEADER_BYTES);
    header.writeUInt32LE(data.length, 0);
    await this.storage.append(partitionId, Buffer.concat([header, data]));
  }

  async *readChunks(partitionId: string): AsyncGenerator<DataChunk> {
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

  async clearPartition(partitionId: string): Promise<void> {
    await this.storage.remove(partitionId);
  }

  async clearAll(): Promise<void> {
    await this.storage.removeAll();
  }

  hasSpilled(partitionId: string): boolean {
    return this.storage.exists(partitionId);
  }
}
