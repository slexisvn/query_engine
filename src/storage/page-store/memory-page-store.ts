import type { DataChunk } from '../chunk.js';
import type { PageStore } from '../page-cache.js';

export class MemoryPageStore implements PageStore {
  pages: Map<string, DataChunk>;

  constructor() {
    this.pages = new Map();
  }

  async write(pageId: string, chunk: DataChunk): Promise<void> {
    this.pages.set(pageId, chunk);
  }

  async read(pageId: string): Promise<DataChunk | null> {
    return this.pages.get(pageId) ?? null;
  }

  clear(): void {
    this.pages.clear();
  }
}
