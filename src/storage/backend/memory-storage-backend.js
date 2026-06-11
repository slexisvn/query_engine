import { MemoryTempSpace } from '../temp-space/memory-temp-space.js';
import { MemoryPageStore } from '../page-store/memory-page-store.js';
import { SpillManager } from '../spill-manager/spill-manager.js';
import { MemoryStorage } from '../spill-manager/memory-storage.js';

export class MemoryStorageBackend {
  constructor(options = {}) {
    this.options = options;
  }

  createTempSpace() {
    return new MemoryTempSpace(this.options);
  }

  createPageStore() {
    return new MemoryPageStore();
  }

  createSpillManager() {
    return new SpillManager(new MemoryStorage());
  }
}
