import { Column } from './column.js';
import { DataChunk, DEFAULT_CHUNK_SIZE } from './chunk.js';
import { BufferPoolManager } from './buffer-pool.js';

export class Table {
  constructor(name, schema) {
    this.name = name;
    this.schema = schema;
    this.pageIds = [];
    this._rowCount = 0;
    this.bufferPool = new BufferPoolManager(50);
    this.activeChunk = null;
  }

  getSchema() {
    return this.schema;
  }

  getColumnIndex(columnName) {
    const upper = columnName.toUpperCase();
    return this.schema.findIndex(col => col.name.toUpperCase() === upper);
  }

  getColumn(columnName) {
    return this.schema.find(col => col.name.toUpperCase() === columnName.toUpperCase());
  }

  rowCount() {
    return this._rowCount + (this.activeChunk ? this.activeChunk.size : 0);
  }

  async addChunk(chunk) {
    const pageId = `${this.name}_page_${this.pageIds.length}`;
    this.pageIds.push(pageId);
    this._rowCount += chunk.size;
    await this.bufferPool.writePage(pageId, chunk);
  }

  async insertRows(rows) {
    if (!this.activeChunk) {
      this.activeChunk = this._createChunk();
    }

    for (const row of rows) {
      if (this.activeChunk.size >= DEFAULT_CHUNK_SIZE) {
        await this.addChunk(this.activeChunk);
        this.activeChunk = this._createChunk();
      }
      this.activeChunk.appendRow(row);
    }
  }

  async flush() {
    if (this.activeChunk && this.activeChunk.size > 0) {
      await this.addChunk(this.activeChunk);
      this.activeChunk = null;
    }
  }

  async *scan() {
    await this.flush();
    for (const pageId of this.pageIds) {
      const chunk = await this.bufferPool.fetchPage(pageId, true);
      yield chunk;
    }
  }

  async scanAll() {
    await this.flush();
    const chunks = [];
    for (const pageId of this.pageIds) {
      chunks.push(await this.bufferPool.fetchPage(pageId, false));
    }
    return chunks;
  }

  getStatistics() {
    return null;
  }

  _createChunk() {
    return DataChunk.fromSchema(this.schema, DEFAULT_CHUNK_SIZE);
  }
}
