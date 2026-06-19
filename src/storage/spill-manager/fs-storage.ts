import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { SPILL_FILE_SUFFIX } from '../storage-constants.js';
import type { SpillStorage } from './spill-manager.js';

export class FsStorage implements SpillStorage {
  basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  filePath(partitionId: string): string {
    return path.join(this.basePath, `${partitionId}${SPILL_FILE_SUFFIX}`);
  }

  async append(partitionId: string, buffer: Buffer): Promise<void> {
    await fsPromises.appendFile(this.filePath(partitionId), buffer);
  }

  async read(partitionId: string): Promise<Buffer | null> {
    const fp = this.filePath(partitionId);
    if (!fs.existsSync(fp)) return null;
    return fsPromises.readFile(fp);
  }

  exists(partitionId: string): boolean {
    return fs.existsSync(this.filePath(partitionId));
  }

  async remove(partitionId: string): Promise<void> {
    const fp = this.filePath(partitionId);
    if (fs.existsSync(fp)) await fsPromises.unlink(fp);
  }

  async removeAll(): Promise<void> {
    if (fs.existsSync(this.basePath)) {
      await fsPromises.rm(this.basePath, { recursive: true, force: true });
    }
  }
}
