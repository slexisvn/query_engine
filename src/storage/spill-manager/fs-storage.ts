import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { SPILL_FILE_SUFFIX } from '../storage-constants.js';
import type { SpillReader, SpillStorage } from './spill-manager.js';

class FileSpillReader implements SpillReader {
  handle: fsPromises.FileHandle;
  position: number;

  constructor(handle: fsPromises.FileHandle) {
    this.handle = handle;
    this.position = 0;
  }

  async read(length: number): Promise<Uint8Array | null> {
    if (length === 0) return Buffer.alloc(0);

    const target = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.handle.read(target, filled, length - filled, this.position + filled);
      if (bytesRead === 0) return null;
      filled += bytesRead;
    }

    this.position += length;
    return target;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export class FsStorage implements SpillStorage {
  basePath: string;
  writeHandles: Map<string, Promise<fsPromises.FileHandle>>;

  constructor(basePath: string) {
    this.basePath = basePath;
    this.writeHandles = new Map();
  }

  filePath(partitionId: string): string {
    return path.join(this.basePath, `${partitionId}${SPILL_FILE_SUFFIX}`);
  }

  writeHandle(partitionId: string): Promise<fsPromises.FileHandle> {
    const cached = this.writeHandles.get(partitionId);
    if (cached) return cached;

    const opening = fsPromises.open(this.filePath(partitionId), 'a');
    this.writeHandles.set(partitionId, opening);
    opening.catch(() => {
      if (this.writeHandles.get(partitionId) === opening) this.writeHandles.delete(partitionId);
    });
    return opening;
  }

  async append(partitionId: string, buffer: Uint8Array): Promise<void> {
    const handle = await this.writeHandle(partitionId);
    await handle.write(buffer);
  }

  async closeWriteHandle(partitionId: string): Promise<void> {
    const pending = this.writeHandles.get(partitionId);
    if (!pending) return;
    this.writeHandles.delete(partitionId);
    const handle = await pending.catch(() => null);
    if (handle) await handle.close();
  }

  async closeAllWriteHandles(): Promise<void> {
    const partitionIds = [...this.writeHandles.keys()];
    for (const partitionId of partitionIds) await this.closeWriteHandle(partitionId);
  }

  async openReader(partitionId: string): Promise<SpillReader | null> {
    await this.closeWriteHandle(partitionId);
    const filePath = this.filePath(partitionId);
    if (!fs.existsSync(filePath)) return null;
    return new FileSpillReader(await fsPromises.open(filePath, 'r'));
  }

  exists(partitionId: string): boolean {
    return fs.existsSync(this.filePath(partitionId));
  }

  async remove(partitionId: string): Promise<void> {
    await this.closeWriteHandle(partitionId);
    const filePath = this.filePath(partitionId);
    if (fs.existsSync(filePath)) await fsPromises.unlink(filePath);
  }

  async removeAll(): Promise<void> {
    await this.closeAllWriteHandles();
    if (!fs.existsSync(this.basePath)) return;

    const entries = await fsPromises.readdir(this.basePath);
    await Promise.all(entries
      .filter((name) => name.endsWith(SPILL_FILE_SUFFIX))
      .map((name) => fsPromises.unlink(path.join(this.basePath, name))));
  }
}
