import { promises as fsPromises } from 'fs';
import fs from 'fs';
import path from 'path';
import { ChunkSerializer } from '../serializer.js';
import { PAGE_FILE_SUFFIX } from '../storage-constants.js';
import type { DataChunk } from '../chunk.js';
import type { PageStore } from '../buffer-pool.js';
import type { Allocator } from '../sab-arena.js';

export type AllocatorFactory = (byteHint: number) => Allocator;

export class FilePageStore implements PageStore {
  basePath: string;
  allocatorFactory: AllocatorFactory | null;

  constructor(basePath: string, allocatorFactory: AllocatorFactory | null = null) {
    this.basePath = basePath;
    this.allocatorFactory = allocatorFactory;
  }

  getPagePath(pageId: string): string {
    return path.join(this.basePath, `${pageId}${PAGE_FILE_SUFFIX}`);
  }

  async write(pageId: string, chunk: DataChunk): Promise<void> {
    const data = ChunkSerializer.serialize(chunk);
    await fsPromises.writeFile(this.getPagePath(pageId), data);
  }

  async read(pageId: string): Promise<DataChunk> {
    const data = await fsPromises.readFile(this.getPagePath(pageId));
    if (this.allocatorFactory) {
      return ChunkSerializer.deserialize(data, this.allocatorFactory(data.length));
    }
    return ChunkSerializer.deserialize(data);
  }

  clear(): void {
    if (fs.existsSync(this.basePath)) {
      fs.rmSync(this.basePath, { recursive: true, force: true });
    }
  }
}
