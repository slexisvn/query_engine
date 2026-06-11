import { LRUCache } from '../utils/lru-cache.js';

export class BufferPoolManager {
  constructor(maxPages, pageStore) {
    this.maxPages = maxPages;
    this.cache = new LRUCache(maxPages);
    this.pageStore = pageStore;
  }

  clear() {
    this.cache.clear();
    this.pageStore.clear();
  }

  async writePage(pageId, chunk) {
    await this.pageStore.write(pageId, chunk);
  }

  async readPage(pageId) {
    return this.pageStore.read(pageId);
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
