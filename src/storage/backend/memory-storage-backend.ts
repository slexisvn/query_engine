import { MemoryTempSpace } from '../temp-space/memory-temp-space.js';
import { MemoryPageStore } from '../page-store/memory-page-store.js';
import { SpillManager } from '../spill-manager/spill-manager.js';
import { MemoryStorage } from '../spill-manager/memory-storage.js';

export interface StorageBackendOptions {
  baseDir?: string;
  tempDir?: string;
}

export class MemoryStorageBackend {
  options: StorageBackendOptions;

  constructor(options: StorageBackendOptions = {}) {
    this.options = options;
  }

  createTempSpace(): MemoryTempSpace {
    return new MemoryTempSpace(this.options);
  }

  createPageStore(): MemoryPageStore {
    return new MemoryPageStore();
  }

  createSpillManager(): SpillManager {
    return new SpillManager(new MemoryStorage());
  }
}
