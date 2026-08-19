import type { DataType } from '../storage/data-type.js';
export interface ColumnInfo { name: string; dataType: DataType | null; }

export interface TableInfo { originalName: string; columns: ColumnInfo[]; isCTE?: boolean; }

export interface ResolvedTable { table: TableInfo; depth: number; }

export interface ResolvedColumn {
  tableAlias: string;
  tableName: string;
  column: ColumnInfo;
  columnIndex: number;
  depth: number;
}

export interface ColumnEntry {
  tableAlias: string;
  tableName: string;
  column: ColumnInfo;
  columnIndex: number;
}

export class BinderScope {
  parent: BinderScope | null;
  tables: Map<string, TableInfo>;
  columns: Map<string, ColumnInfo[]>;
  columnIndexes: Map<string, Map<string, number>>;

  constructor(parent: BinderScope | null = null) {
    this.parent = parent;
    this.tables = new Map();
    this.columns = new Map();
    this.columnIndexes = new Map();
  }

  addTable(alias: string, tableInfo: TableInfo): void {
    const key = alias.toUpperCase();
    this.tables.set(key, tableInfo);
    this.columnIndexes.set(key, indexColumns(tableInfo.columns));
  }

  columnIndexIn(tableAlias: string, columnName: string): number {
    return this.columnIndexes.get(tableAlias)?.get(columnName) ?? -1;
  }

  addColumn(alias: string, columnInfo: ColumnInfo): void {
    const key = alias.toUpperCase();
    if (!this.columns.has(key)) {
      this.columns.set(key, []);
    }
    this.columns.get(key)!.push(columnInfo);
  }

  resolveTable(name: string): ResolvedTable | null {
    const upper = name.toUpperCase();
    const local = this.tables.get(upper);
    if (local) return { table: local, depth: 0 };
    if (this.parent) {
      const result = this.parent.resolveTable(upper);
      if (result) return { table: result.table, depth: result.depth + 1 };
    }
    return null;
  }

  resolveColumn(name: string, tableAlias: string | null = null): ResolvedColumn | null {
    const upper = name.toUpperCase();

    if (tableAlias) {
      const tableUpper = tableAlias.toUpperCase();
      const tableResult = this.resolveTable(tableAlias);
      if (!tableResult) return null;

      const { table, depth } = tableResult;
      const colIndex = this.ownerScopeOf(tableUpper)?.columnIndexIn(tableUpper, upper) ?? -1;
      if (colIndex < 0) return null;

      return {
        tableAlias: tableUpper,
        tableName: table.originalName || tableUpper,
        column: table.columns[colIndex],
        columnIndex: colIndex,
        depth,
      };
    }

    let found: ResolvedColumn | null = null;

    for (const [alias, tableInfo] of this.tables) {
      const colIndex = this.columnIndexIn(alias, upper);
      if (colIndex >= 0) {
        if (found) {
          throw new Error(`Ambiguous column reference: ${name}`);
        }
        found = {
          tableAlias: alias,
          tableName: tableInfo.originalName || alias,
          column: tableInfo.columns[colIndex],
          columnIndex: colIndex,
          depth: 0,
        };
      }
    }

    if (found) return found;

    if (this.parent) {
      const parentResult = this.parent.resolveColumn(name);
      if (parentResult) {
        return { ...parentResult, depth: parentResult.depth + 1 };
      }
    }

    return null;
  }

  getAllColumns(): ColumnEntry[] {
    const result: ColumnEntry[] = [];
    for (const [alias, tableInfo] of this.tables) {
      for (let i = 0; i < tableInfo.columns.length; i++) {
        result.push({
          tableAlias: alias,
          tableName: tableInfo.originalName || alias,
          column: tableInfo.columns[i],
          columnIndex: i,
        });
      }
    }
    return result;
  }

  getTableColumns(tableAlias: string): ColumnEntry[] | null {
    const upper = tableAlias.toUpperCase();
    const tableInfo = this.tables.get(upper);
    if (!tableInfo) return null;
    return tableInfo.columns.map((col, i) => ({
      tableAlias: upper,
      tableName: tableInfo.originalName || upper,
      column: col,
      columnIndex: i,
    }));
  }

  ownerScopeOf(tableAlias: string): BinderScope | null {
    if (this.tables.has(tableAlias)) return this;
    return this.parent ? this.parent.ownerScopeOf(tableAlias) : null;
  }

  child(): BinderScope {
    return new BinderScope(this);
  }
}

function indexColumns(columns: ColumnInfo[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < columns.length; i++) {
    const key = columns[i].name.toUpperCase();
    if (!index.has(key)) index.set(key, i);
  }
  return index;
}
