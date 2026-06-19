import { LRUCache } from '../utils/lru-cache.js';
import type { DataChunk } from './chunk.js';

export interface PageStore {
  write(pageId: string, chunk: DataChunk): Promise<void>;
  read(pageId: string): Promise<DataChunk | null>;
  clear(): void;
}

export class BufferPoolManager {
  maxPages: number;
  cache: LRUCache;
  pageStore: PageStore;

  constructor(maxPages: number, pageStore: PageStore) {
    this.maxPages = maxPages;
    this.cache = new LRUCache(maxPages);
    this.pageStore = pageStore;
  }

  clear(): void {
    this.cache.clear();
    this.pageStore.clear();
  }

  async writePage(pageId: string, chunk: DataChunk): Promise<void> {
    await this.pageStore.write(pageId, chunk);
  }

  async readPage(pageId: string): Promise<DataChunk | null> {
    return this.pageStore.read(pageId);
  }

  async fetchPage(pageId: string, bypassCache = false): Promise<DataChunk | null> {
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
