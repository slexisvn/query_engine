import { promises as fsPromises } from 'fs';
import fs from 'fs';
import path from 'path';
import { ChunkSerializer } from '../serializer.js';
import { PAGE_FILE_SUFFIX } from '../storage-constants.js';

export class FilePageStore {
  constructor(basePath, allocatorFactory = null) {
    this.basePath = basePath;
    this.allocatorFactory = allocatorFactory;
  }

  getPagePath(pageId) {
    return path.join(this.basePath, `${pageId}${PAGE_FILE_SUFFIX}`);
  }

  async write(pageId, chunk) {
    const data = ChunkSerializer.serialize(chunk);
    await fsPromises.writeFile(this.getPagePath(pageId), data);
  }

  async read(pageId) {
    const data = await fsPromises.readFile(this.getPagePath(pageId));
    if (this.allocatorFactory) {
      return ChunkSerializer.deserialize(data, this.allocatorFactory(data.length));
    }
    return ChunkSerializer.deserialize(data);
  }

  clear() {
    if (fs.existsSync(this.basePath)) {
      fs.rmSync(this.basePath, { recursive: true, force: true });
    }
  }
}
