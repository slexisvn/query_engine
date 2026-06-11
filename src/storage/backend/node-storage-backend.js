import { TempDirectoryManager } from '../temp-space/temp-directory-manager.js';
import { FilePageStore } from '../page-store/file-page-store.js';
import { SpillManager } from '../spill-manager/spill-manager.js';
import { FsStorage } from '../spill-manager/fs-storage.js';
import { columnAllocator } from '../sab-arena.js';

export class NodeStorageBackend {
  constructor(options = {}) {
    this.options = options;
  }

  createTempSpace() {
    return new TempDirectoryManager(this.options.tempDir ? { baseDir: this.options.tempDir } : {});
  }

  createPageStore(handle) {
    return new FilePageStore(handle, columnAllocator);
  }

  createSpillManager(handle) {
    return new SpillManager(new FsStorage(handle));
  }
}
