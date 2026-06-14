export interface ColumnInfo { name: string; dataType: string | null; }

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
  correlatedRefs: unknown[];

  constructor(parent: BinderScope | null = null) {
    this.parent = parent;
    this.tables = new Map();
    this.columns = new Map();
    this.correlatedRefs = [];
  }

  addTable(alias: string, tableInfo: TableInfo): void {
    this.tables.set(alias.toUpperCase(), tableInfo);
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
      const col = table.columns.find(c => c.name.toUpperCase() === upper);
      if (!col) return null;

      const colIndex = table.columns.findIndex(c => c.name.toUpperCase() === upper);
      return {
        tableAlias: tableUpper,
        tableName: table.originalName || tableUpper,
        column: col,
        columnIndex: colIndex,
        depth,
      };
    }

    let found: ResolvedColumn | null = null;
    let foundDepth = 0;

    for (const [alias, tableInfo] of this.tables) {
      const colIndex = tableInfo.columns.findIndex(c => c.name.toUpperCase() === upper);
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

  child(): BinderScope {
    return new BinderScope(this);
  }
}
