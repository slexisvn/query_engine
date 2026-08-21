import { DEFAULT_CHUNK_SIZE } from '../config.js';
import { DataChunk } from './chunk.js';
import { PageCache, type PageStore } from './page-cache.js';
import { Config } from '../config.js';
import type { ColumnSchema, ColumnValue } from './data-type.js';
import type { BTreeIndex } from './btree.js';
import { buildChunkZoneMap, type ChunkPruner, type ChunkZoneMap } from './zone-map.js';
import { encodeChunkColumns } from './encoding/column-encoding.js';

interface TableIndex {
  columnIndex: number;
  btree: BTreeIndex;
}

export class Table {
  name: string;
  schema: ColumnSchema[];
  pageIds: string[];
  zoneMaps: ChunkZoneMap[];
  _rowCount: number;
  pageCache: PageCache;
  activeChunk: DataChunk | null;
  indexes: TableIndex[];

  constructor(name: string, schema: ColumnSchema[], pageStore: PageStore) {
    this.name = name;
    this.schema = schema;
    this.pageIds = [];
    this.zoneMaps = [];
    this._rowCount = 0;
    this.pageCache = new PageCache(Config.pageCachePages, pageStore);
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
    const stored = encodeChunkColumns(chunk);
    const pageId = `${this.name}_page_${this.pageIds.length}`;
    this.pageIds.push(pageId);
    this.zoneMaps.push(buildChunkZoneMap(stored));
    this._rowCount += stored.size;
    await this.pageCache.writePage(pageId, stored);

    for (const idx of this.indexes) {
      for (let r = 0; r < stored.size; r++) {
        const key = stored.columns[idx.columnIndex].get(r);
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

  async *scan(pruner: ChunkPruner | null = null): AsyncGenerator<DataChunk> {
    await this.flush();
    for (let i = 0; i < this.pageIds.length; i++) {
      if (pruner && pruner.canSkip(this.zoneMaps[i])) continue;
      const chunk = await this.pageCache.fetchPage(this.pageIds[i], true);
      yield (chunk as DataChunk).scanView();
    }
  }

  async scanAll(): Promise<DataChunk[]> {
    await this.flush();
    const chunks: DataChunk[] = [];
    for (const pageId of this.pageIds) {
      chunks.push((await this.pageCache.fetchPage(pageId, false) as DataChunk).scanView());
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
