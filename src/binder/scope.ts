import type { DataType } from '../storage/data-type.js';
export interface ColumnInfo { name: string; dataType: DataType | null; }

export interface TableInfo { originalName: string; columns: ColumnInfo[]; isCTE?: boolean; }

export interface ResolvedTable { table: TableInfo; alias: string; depth: number; }

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

interface ScopeRelation {
  alias: string;
  table: TableInfo;
  columnIndex: Map<string, number>;
}

const SHADOW_ALIAS_SEPARATOR = ':';

export class BinderScope {
  parent: BinderScope | null;
  tables: Map<string, TableInfo>;
  columns: Map<string, ColumnInfo[]>;
  relations: Map<string, ScopeRelation>;
  aliasIndex: Map<string, string>;
  shadowCount: number;
  queryBoundary: boolean;

  constructor(parent: BinderScope | null = null, queryBoundary: boolean = false) {
    this.parent = parent;
    this.queryBoundary = queryBoundary;
    this.tables = new Map();
    this.columns = new Map();
    this.relations = new Map();
    this.aliasIndex = new Map();
    this.shadowCount = 0;
  }

  root(): BinderScope {
    return this.parent ? this.parent.root() : this;
  }

  addTable(alias: string, tableInfo: TableInfo): string {
    const key = alias.toUpperCase();
    const relationAlias = this.resolveTable(key) ? this.shadowAliasFor(key) : key;
    this.tables.set(key, tableInfo);
    this.relations.set(key, {
      alias: relationAlias,
      table: tableInfo,
      columnIndex: indexColumns(tableInfo.columns),
    });
    this.aliasIndex.set(key, key);
    this.aliasIndex.set(relationAlias, key);
    return relationAlias;
  }

  shadowAliasFor(key: string): string {
    const root = this.root();
    return `${key}${SHADOW_ALIAS_SEPARATOR}${++root.shadowCount}`;
  }

  localRelation(alias: string): ScopeRelation | null {
    const key = this.aliasIndex.get(alias);
    return key === undefined ? null : this.relations.get(key)!;
  }

  columnIndexIn(tableAlias: string, columnName: string): number {
    return this.localRelation(tableAlias)?.columnIndex.get(columnName) ?? -1;
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
    const local = this.localRelation(upper);
    if (local) return { table: local.table, alias: local.alias, depth: 0 };
    if (this.parent) {
      const result = this.parent.resolveTable(upper);
      if (result) return { ...result, depth: result.depth + 1 };
    }
    return null;
  }

  resolveColumn(name: string, tableAlias: string | null = null): ResolvedColumn | null {
    const upper = name.toUpperCase();

    if (tableAlias) {
      const tableUpper = tableAlias.toUpperCase();
      const owner = this.ownerScopeOf(tableUpper);
      if (!owner) return null;

      const relation = owner.localRelation(tableUpper)!;
      const colIndex = relation.columnIndex.get(upper) ?? -1;
      if (colIndex < 0) return null;

      return {
        tableAlias: relation.alias,
        tableName: relation.table.originalName || relation.alias,
        column: relation.table.columns[colIndex],
        columnIndex: colIndex,
        depth: this.depthOf(owner),
      };
    }

    let found: ResolvedColumn | null = null;

    for (const relation of this.relations.values()) {
      const colIndex = relation.columnIndex.get(upper) ?? -1;
      if (colIndex >= 0) {
        if (found) {
          throw new Error(`Ambiguous column reference: ${name}`);
        }
        found = {
          tableAlias: relation.alias,
          tableName: relation.table.originalName || relation.alias,
          column: relation.table.columns[colIndex],
          columnIndex: colIndex,
          depth: 0,
        };
      }
    }

    if (found) return found;

    if (this.parent) {
      const parentResult = this.parent.resolveColumn(name);
      if (parentResult) {
        return { ...parentResult, depth: parentResult.depth + (this.queryBoundary ? 1 : 0) };
      }
    }

    return null;
  }

  depthOf(scope: BinderScope): number {
    let depth = 0;
    for (let current: BinderScope | null = this; current; current = current.parent) {
      if (current === scope) return depth;
      if (current.queryBoundary) depth++;
    }
    return depth;
  }

  getAllColumns(): ColumnEntry[] {
    const result: ColumnEntry[] = [];
    for (const relation of this.relations.values()) {
      for (let i = 0; i < relation.table.columns.length; i++) {
        result.push({
          tableAlias: relation.alias,
          tableName: relation.table.originalName || relation.alias,
          column: relation.table.columns[i],
          columnIndex: i,
        });
      }
    }
    return result;
  }

  getTableColumns(tableAlias: string): ColumnEntry[] | null {
    const relation = this.localRelation(tableAlias.toUpperCase());
    if (!relation) return null;
    return relation.table.columns.map((col, i) => ({
      tableAlias: relation.alias,
      tableName: relation.table.originalName || relation.alias,
      column: col,
      columnIndex: i,
    }));
  }

  ownerScopeOf(tableAlias: string): BinderScope | null {
    if (this.aliasIndex.has(tableAlias)) return this;
    return this.parent ? this.parent.ownerScopeOf(tableAlias) : null;
  }

  child(): BinderScope {
    return new BinderScope(this);
  }

  subqueryChild(): BinderScope {
    return new BinderScope(this, true);
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
