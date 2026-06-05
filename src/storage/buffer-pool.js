import { promises as fsPromises } from 'fs';
import fs from 'fs';
import path from 'path';
import { ChunkSerializer } from './serializer.js';
import { LRUCache } from '../utils/lru-cache.js';

export class BufferPoolManager {
  constructor(maxPages, basePath) {
    this.maxPages = maxPages;
    this.cache = new LRUCache(maxPages);
    this.storageDir = basePath;
  }

  clear() {
    this.cache.clear();
    if (fs.existsSync(this.storageDir)) {
      fs.rmSync(this.storageDir, { recursive: true, force: true });
    }
  }

  getPagePath(pageId) {
    return path.join(this.storageDir, `${pageId}.qdat`);
  }

  async writePage(pageId, chunk) {
    const data = ChunkSerializer.serialize(chunk);
    await fsPromises.writeFile(this.getPagePath(pageId), data);
  }

  async readPage(pageId) {
    const data = await fsPromises.readFile(this.getPagePath(pageId));
    return ChunkSerializer.deserialize(data);
  }

  async fetchPage(pageId, bypassCache = false) {
    const cached = this.cache.get(pageId);
    if (cached !== undefined) {
      return cached;
    }

    const chunk = await this.readPage(pageId);

    if (bypassCache) {
      return chunk;
    }

    this.cache.set(pageId, chunk);
    return chunk;
  }
}
