import type { ColumnSchema } from '../storage/data-type.js';
import type { Table } from '../storage/table.js';
import type { BTreeIndex } from '../storage/btree.js';

export interface ForeignKeySchema {
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface CatalogTableOptions {
  primaryKey?: string[];
  foreignKeys?: ForeignKeySchema[];
}

export interface CatalogTable {
  name: string;
  columns: ColumnSchema[];
  primaryKey: string[];
  foreignKeys: ForeignKeySchema[];
}

export interface IndexEntry {
  tableName: string;
  columnName: string;
  btree: BTreeIndex;
}

export interface PartitionStrategyLike {
  name?: string;
}

export type PartitionKeyLike = string | string[] | Map<string, number>;

export interface PartitionInfo {
  strategy: PartitionStrategyLike;
  partitionCount: number;
  partitionKey: PartitionKeyLike;
}

export class Catalog {
  tables: Map<string, CatalogTable>;
  tableStorage: Map<string, Table>;
  indexes: Map<string, IndexEntry>;
  partitionInfo: Map<string, PartitionInfo>;

  constructor() {
    this.tables = new Map();
    this.tableStorage = new Map();
    this.indexes = new Map();
    this.partitionInfo = new Map();
  }

  registerTable(name: string, schema: ColumnSchema[], options: CatalogTableOptions = {}): void {
    const upperName = name.toUpperCase();
    this.tables.set(upperName, {
      name: upperName,
      columns: schema,
      primaryKey: options.primaryKey || [],
      foreignKeys: options.foreignKeys || [],
    });
  }

  registerTableStorage(name: string, storage: Table): void {
    this.tableStorage.set(name.toUpperCase(), storage);
  }

  getTable(name: string): CatalogTable | null {
    return this.tables.get(name.toUpperCase()) || null;
  }

  getTableStorage(name: string): Table | null {
    return this.tableStorage.get(name.toUpperCase()) || null;
  }

  getColumn(tableName: string, columnName: string): ColumnSchema | null {
    const table = this.getTable(tableName);
    if (!table) return null;
    const upper = columnName.toUpperCase();
    return table.columns.find(c => c.name.toUpperCase() === upper) || null;
  }

  getColumnIndex(tableName: string, columnName: string): number {
    const table = this.getTable(tableName);
    if (!table) return -1;
    const upper = columnName.toUpperCase();
    return table.columns.findIndex(c => c.name.toUpperCase() === upper);
  }

  dropTable(name: string): void {
    const upper = name.toUpperCase();
    this.tables.delete(upper);
    this.tableStorage.delete(upper);
    for (const [key, entry] of this.indexes) {
      if (entry.tableName === upper) this.indexes.delete(key);
    }
  }

  hasTable(name: string): boolean {
    return this.tables.has(name.toUpperCase());
  }

  listTables(): string[] {
    return Array.from(this.tables.keys());
  }

  registerIndex(tableName: string, columnName: string, btree: BTreeIndex): void {
    const key = `${tableName.toUpperCase()}.${columnName.toUpperCase()}`;
    this.indexes.set(key, { tableName: tableName.toUpperCase(), columnName: columnName.toUpperCase(), btree });
  }

  getIndexForColumn(tableName: string, columnName: string): BTreeIndex | null {
    const key = `${tableName.toUpperCase()}.${columnName.toUpperCase()}`;
    const entry = this.indexes.get(key);
    return entry ? entry.btree : null;
  }

  getIndexesForTable(tableName: string): IndexEntry[] {
    const upper = tableName.toUpperCase();
    const result: IndexEntry[] = [];
    for (const entry of this.indexes.values()) {
      if (entry.tableName === upper) result.push(entry);
    }
    return result;
  }

  registerPartitionInfo(tableName: string, strategy: PartitionStrategyLike, partitionCount: number, partitionKey: PartitionKeyLike): void {
    this.partitionInfo.set(tableName.toUpperCase(), { strategy, partitionCount, partitionKey });
  }

  getPartitionInfo(tableName: string): PartitionInfo | null {
    return this.partitionInfo.get(tableName.toUpperCase()) || null;
  }
}
