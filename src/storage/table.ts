import { Column } from './column.js';
import { DataChunk, DEFAULT_CHUNK_SIZE } from './chunk.js';
import { BufferPoolManager, type PageStore } from './buffer-pool.js';
import { Config } from '../config.js';
import type { ColumnSchema, ColumnValue } from './data-type.js';
import type { BTreeIndex } from './btree.js';

interface TableIndex {
  columnIndex: number;
  btree: BTreeIndex;
}

export class Table {
  name: string;
  schema: ColumnSchema[];
  pageIds: string[];
  _rowCount: number;
  bufferPool: BufferPoolManager;
  activeChunk: DataChunk | null;
  indexes: TableIndex[];

  constructor(name: string, schema: ColumnSchema[], pageStore: PageStore) {
    this.name = name;
    this.schema = schema;
    this.pageIds = [];
    this._rowCount = 0;
    this.bufferPool = new BufferPoolManager(Config.bufferPoolPages, pageStore);
    this.activeChunk = null;
    this.indexes = [];
  }

  getSchema(): ColumnSchema[] {
    return this.schema;
  }

  getColumnIndex(columnName: string): number {
    const upper = columnName.toUpperCase();
    return this.schema.findIndex(col => col.name.toUpperCase() === upper);
  }

  getColumn(columnName: string): ColumnSchema | undefined {
    return this.schema.find(col => col.name.toUpperCase() === columnName.toUpperCase());
  }

  rowCount(): number {
    return this._rowCount + (this.activeChunk ? this.activeChunk.size : 0);
  }

  registerIndex(columnIndex: number, btree: BTreeIndex): void {
    this.indexes.push({ columnIndex, btree });
  }

  async addChunk(chunk: DataChunk): Promise<void> {
    const pageId = `${this.name}_page_${this.pageIds.length}`;
    this.pageIds.push(pageId);
    this._rowCount += chunk.size;
    await this.bufferPool.writePage(pageId, chunk);

    for (const idx of this.indexes) {
      for (let r = 0; r < chunk.size; r++) {
        const key = chunk.columns[idx.columnIndex].get(r);
        if (key !== null && key !== undefined) {
          idx.btree.insert(key, { pageId, rowIndex: r });
        }
      }
    }
  }

  async insertRows(rows: ColumnValue[][]): Promise<void> {
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

  async flush(): Promise<void> {
    if (this.activeChunk && this.activeChunk.size > 0) {
      await this.addChunk(this.activeChunk);
      this.activeChunk = null;
    }
  }

  async *scan(): AsyncGenerator<DataChunk> {
    await this.flush();
    for (const pageId of this.pageIds) {
      const chunk = await this.bufferPool.fetchPage(pageId, true);
      yield chunk as DataChunk;
    }
  }

  async scanAll(): Promise<DataChunk[]> {
    await this.flush();
    const chunks: DataChunk[] = [];
    for (const pageId of this.pageIds) {
      chunks.push(await this.bufferPool.fetchPage(pageId, false) as DataChunk);
    }
    return chunks;
  }

  getStatistics(): null {
    return null;
  }

  _createChunk(): DataChunk {
    return DataChunk.fromSchema(this.schema, DEFAULT_CHUNK_SIZE);
  }
}
