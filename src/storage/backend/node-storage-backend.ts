import { TempDirectoryManager } from '../temp-space/temp-directory-manager.js';
import { FilePageStore } from '../page-store/file-page-store.js';
import { SpillManager } from '../spill-manager/spill-manager.js';
import { FsStorage } from '../spill-manager/fs-storage.js';
import { columnAllocator } from '../sab-arena.js';
import type { StorageBackendOptions } from './memory-storage-backend.js';

export class NodeStorageBackend {
  options: StorageBackendOptions;

  constructor(options: StorageBackendOptions = {}) {
    this.options = options;
  }

  createTempSpace(): TempDirectoryManager {
    return new TempDirectoryManager(this.options.tempDir ? { baseDir: this.options.tempDir } : {});
  }

  createPageStore(handle: string): FilePageStore {
    return new FilePageStore(handle, columnAllocator);
  }

  createSpillManager(handle: string): SpillManager {
    return new SpillManager(new FsStorage(handle));
  }
}
