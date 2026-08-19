import { ChunkSerializer } from '../serializer.js';
import type { DataChunk } from '../chunk.js';

export interface SpillReader {
  read(length: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

export interface SpillStorage {
  append(partitionId: string, buffer: Buffer): Promise<void>;
  openReader(partitionId: string): Promise<SpillReader | null>;
  exists(partitionId: string): boolean;
  remove(partitionId: string): Promise<void>;
  removeAll(): Promise<void>;
}

export interface ChunkSpillStore {
  appendChunk(partitionId: string, chunk: DataChunk | null): Promise<void>;
  readChunks(partitionId: string): AsyncGenerator<DataChunk>;
  clearPartition(partitionId: string): Promise<void>;
  clearAll(): Promise<void>;
}

const LENGTH_HEADER_BYTES = 4;

export class SpillManager implements ChunkSpillStore {
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
    const reader = await this.storage.openReader(partitionId);
    if (!reader) return;

    try {
      for (;;) {
        const header = await reader.read(LENGTH_HEADER_BYTES);
        if (!header) return;
        const payload = await reader.read(header.readUInt32LE(0));
        if (!payload) return;
        yield ChunkSerializer.deserialize(payload);
      }
    } finally {
      await reader.close();
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
