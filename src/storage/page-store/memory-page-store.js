export class MemoryPageStore {
  constructor() {
    this.pages = new Map();
  }

  async write(pageId, chunk) {
    this.pages.set(pageId, chunk);
  }

  async read(pageId) {
    return this.pages.get(pageId) ?? null;
  }

  clear() {
    this.pages.clear();
  }
}
