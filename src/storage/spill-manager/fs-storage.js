import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { SPILL_FILE_SUFFIX } from '../storage-constants.js';

export class FsStorage {
  constructor(basePath) {
    this.basePath = basePath;
  }

  filePath(partitionId) {
    return path.join(this.basePath, `${partitionId}${SPILL_FILE_SUFFIX}`);
  }

  async append(partitionId, buffer) {
    await fsPromises.appendFile(this.filePath(partitionId), buffer);
  }

  async read(partitionId) {
    const fp = this.filePath(partitionId);
    if (!fs.existsSync(fp)) return null;
    return fsPromises.readFile(fp);
  }

  exists(partitionId) {
    return fs.existsSync(this.filePath(partitionId));
  }

  async remove(partitionId) {
    const fp = this.filePath(partitionId);
    if (fs.existsSync(fp)) await fsPromises.unlink(fp);
  }

  async removeAll() {
    if (fs.existsSync(this.basePath)) {
      await fsPromises.rm(this.basePath, { recursive: true, force: true });
    }
  }
}
