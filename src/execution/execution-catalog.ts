import type { BTreeIndex } from '../storage/btree.js';
import type { TableStorage } from '../storage/table-storage.js';

export interface ExecutionCatalog {
  getTableStorage(name: string): TableStorage | null;
  getIndexForColumn(table: string, column: string): BTreeIndex | null;
}
