import { promises as fsPromises } from 'fs';
import fs from 'fs';
import path from 'path';
import { ChunkSerializer } from './serializer.js';

export class BufferPoolManager {
  constructor(maxPages = 100) {
    this.maxPages = maxPages;
    this.pages = new Map();
    this.lru = [];
    
    const uniqueId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    this.storageDir = path.join(process.cwd(), '.query_engine_tmp', uniqueId);
    
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  clear() {
    this.pages.clear();
    this.lru = [];
    if (fs.existsSync(this.storageDir)) {
      fs.rmSync(this.storageDir, { recursive: true, force: true });
    }
  }

  getPagePath(pageId) {
    return path.join(this.storageDir, `${pageId}.qdat`);
  }

  async writePage(pageId, chunk) {
    const jsonStr = ChunkSerializer.serialize(chunk);
    await fsPromises.writeFile(this.getPagePath(pageId), jsonStr, 'utf8');
  }

  async readPage(pageId) {
    const jsonStr = await fsPromises.readFile(this.getPagePath(pageId), 'utf8');
    return ChunkSerializer.deserialize(jsonStr);
  }

  async fetchPage(pageId, bypassCache = false) {
    if (this.pages.has(pageId)) {
      if (!bypassCache) {
        this.lru = this.lru.filter(id => id !== pageId);
        this.lru.push(pageId);
      }
      return this.pages.get(pageId);
    }

    const chunk = await this.readPage(pageId);
    
    if (bypassCache) {
      return chunk;
    }

    if (this.pages.size >= this.maxPages) {
      const evictId = this.lru.shift();
      this.pages.delete(evictId);
    }

    this.pages.set(pageId, chunk);
    this.lru.push(pageId);
    return chunk;
  }
}
