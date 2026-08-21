import type { DataChunk } from './chunk.js';
import type { ColumnSchema, ColumnValue } from './data-type.js';
import type { BTreeIndex } from './btree.js';
import type { ChunkPruner } from './zone-map.js';

export interface TableIndex {
  columnIndex: number;
  btree: BTreeIndex;
}

export interface PageReader {
  fetchPage(pageId: string, bypassCache: boolean): Promise<DataChunk | null>;
}

export interface TableStorage {
  getSchema(): ColumnSchema[];
  rowCount(): number;
  getColumnIndex(columnName: string): number;
  scan(pruner?: ChunkPruner | null): AsyncGenerator<DataChunk>;
  scanAll(): Promise<DataChunk[]>;
}

export interface PagedTableStorage extends TableStorage {
  pageIds: string[];
  pageCache: PageReader;
  indexes: TableIndex[];
  registerIndex(columnIndex: number, btree: BTreeIndex): void;
  insertRows(rows: ColumnValue[][]): Promise<void>;
  flush(): Promise<void>;
}

export function isPagedTableStorage(storage: TableStorage): storage is PagedTableStorage {
  return Array.isArray((storage as PagedTableStorage).pageIds);
}
