import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import readline from 'readline';
import { ChunkSerializer } from './serializer.js';

export class SpillManager {
  constructor() {
    const uniqueId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    this.storageDir = path.join(process.cwd(), '.query_engine_tmp', 'spills', uniqueId);
    
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  getFilePath(partitionId) {
    return path.join(this.storageDir, `${partitionId}.spill`);
  }

  async appendChunk(partitionId, chunk) {
    if (!chunk || chunk.size === 0) return;
    const jsonStr = ChunkSerializer.serialize(chunk);
    await fsPromises.appendFile(this.getFilePath(partitionId), jsonStr + '\n', 'utf8');
  }

  async *readChunks(partitionId) {
    const filePath = this.getFilePath(partitionId);
    if (!fs.existsSync(filePath)) {
      return;
    }

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      yield ChunkSerializer.deserialize(line);
    }
  }

  async clearPartition(partitionId) {
    const filePath = this.getFilePath(partitionId);
    if (fs.existsSync(filePath)) {
      await fsPromises.unlink(filePath);
    }
  }

  async clearAll() {
    if (fs.existsSync(this.storageDir)) {
      await fsPromises.rm(this.storageDir, { recursive: true, force: true });
    }
  }

  hasSpilled(partitionId) {
    return fs.existsSync(this.getFilePath(partitionId));
  }
}
