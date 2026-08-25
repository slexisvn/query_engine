import { QueryEngine } from '@engine/engine/query-engine.js';
import { MemoryStorageBackend } from '@engine/storage/backend/memory-storage-backend.js';
import { registerTable } from '@engine/engine-entry.js';
import { collectScannedTables } from '@engine/planner/logical-plan.js';
import {
  buildStatistics,
  createDemoCatalog,
  dropSampleTables,
  loadSampleData,
  registerSampleTables,
  DEFAULT_ROW_COUNTS,
  DEMO_SCHEMA,
  INDEXED_COLUMNS,
} from './demo-catalog.js';
import { parseCsv, tableNameFromFile } from './csv.js';
import { compile } from './compile.js';
import type { Catalog } from '@engine/catalog/catalog.js';
import type { TableStats } from '@engine/catalog/statistics.js';
import type { ColumnSchema, ColumnValue } from '@engine/storage/data-type.js';
import type { RowCounts } from './demo-catalog.js';

export const RESULT_ROW_CAP = 5000;
export const PREVIEW_ROW_CAP = 1000;

type EngineOptions = ConstructorParameters<typeof QueryEngine>[1];

export type TableKind = 'sample' | 'imported';

export interface TableEntry {
  name: string;
  kind: TableKind;
  columns: ColumnSchema[];
  rowCount: number;
  dataRows: number;
  indexed: readonly string[];
  preview: readonly ResultRow[];
}

export type ResultRow = Record<string, ColumnValue>;

export interface RunSuccess {
  ok: true;
  columns: string[];
  rowKeys: string[];
  rows: ResultRow[];
  total: number;
  truncated: boolean;
  ms: number;
}

export interface RunNoData {
  ok: false;
  reason: 'no-data';
  tables: string[];
}

export interface RunFailed {
  ok: false;
  reason: 'error';
  message: string;
}

export type RunOutcome = RunSuccess | RunNoData | RunFailed;

export interface ImportResult {
  ok: true;
  table: TableEntry;
}

export interface ImportFailure {
  ok: false;
  message: string;
}

export type ImportOutcome = ImportResult | ImportFailure;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Workspace {
  readonly engine: QueryEngine;
  readonly ready: Promise<void>;
  version = 0;

  private rowCounts: RowCounts = DEFAULT_ROW_COUNTS;
  private sampleLoaded = true;
  private sampleDataRows: RowCounts = {};
  private readonly imported = new Map<string, TableEntry>();
  private readonly importedStats = new Map<string, TableStats>();
  private cachedStatistics: Map<string, TableStats> | null = null;

  constructor() {
    const options: EngineOptions = { storageBackend: new MemoryStorageBackend() };
    this.engine = new QueryEngine(createDemoCatalog(), options);
    this.ready = this.loadSampleRows();
  }

  private async loadSampleRows(): Promise<void> {
    this.sampleDataRows = await loadSampleData(this.engine);
    this.invalidate();
  }

  get sampleDataTotal(): number {
    return Object.values(this.sampleDataRows).reduce((total, count) => total + count, 0);
  }

  get catalog(): Catalog {
    return this.engine.catalog;
  }

  private invalidate(): void {
    this.version++;
    this.cachedStatistics = null;
  }

  get usesSampleSchema(): boolean {
    return this.sampleLoaded;
  }

  statistics(): Map<string, TableStats> {
    if (this.cachedStatistics === null) {
      const merged = this.sampleLoaded ? buildStatistics(this.rowCounts) : new Map<string, TableStats>();
      for (const [name, stats] of this.importedStats) merged.set(name, stats);
      this.cachedStatistics = merged;
    }
    return this.cachedStatistics;
  }

  tables(): TableEntry[] {
    if (!this.sampleLoaded) return [...this.imported.values()];

    const sample: TableEntry[] = Object.keys(DEMO_SCHEMA).map(name => ({
      name,
      kind: 'sample',
      columns: this.catalog.getTable(name)?.columns ?? [],
      rowCount: this.rowCounts[name] ?? 0,
      dataRows: this.sampleDataRows[name] ?? 0,
      indexed: INDEXED_COLUMNS[name] ?? [],
      preview: [],
    }));
    return [...sample, ...this.imported.values()];
  }

  sampleRowCounts(): RowCounts {
    return this.rowCounts;
  }

  setRowCount(table: string, rowCount: number): void {
    if (this.imported.has(table)) return;
    this.rowCounts = { ...this.rowCounts, [table]: Math.max(0, rowCount) };
    this.invalidate();
  }

  resetRowCounts(): void {
    this.rowCounts = DEFAULT_ROW_COUNTS;
    this.invalidate();
  }

  hasData(table: string): boolean {
    return this.catalog.getTableStorage(table) !== null;
  }

  async importCsv(fileName: string, text: string): Promise<ImportOutcome> {
    const name = tableNameFromFile(fileName);
    if (this.sampleLoaded && DEMO_SCHEMA[name] !== undefined) {
      return { ok: false, message: `${name} is a sample table — rename the file to import it` };
    }

    let table: TableEntry;
    try {
      const parsed = parseCsv(text);
      if (parsed.columns.length === 0) return { ok: false, message: 'that file has no header row' };
      if (parsed.rows.length === 0) return { ok: false, message: 'that file has a header but no rows' };

      const rows = parsed.rows as ResultRow[];
      const columns = registerTable(this.engine, name, rows);
      table = {
        name,
        kind: 'imported',
        columns,
        rowCount: rows.length,
        dataRows: rows.length,
        indexed: [],
        preview: rows.slice(0, PREVIEW_ROW_CAP),
      };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }

    const collected = await this.engine.collectStatistics([name]);
    const stats = collected?.get(name);
    if (stats) this.importedStats.set(name, stats);

    this.imported.set(name, table);
    if (this.sampleLoaded) {
      dropSampleTables(this.catalog);
      this.sampleLoaded = false;
    }
    this.invalidate();
    return { ok: true, table };
  }

  async dropTable(name: string): Promise<void> {
    if (!this.imported.has(name)) return;
    this.catalog.dropTable(name);
    this.imported.delete(name);
    this.importedStats.delete(name);

    if (this.imported.size === 0 && !this.sampleLoaded) {
      registerSampleTables(this.catalog);
      this.sampleLoaded = true;
      await this.loadSampleRows();
      return;
    }

    this.invalidate();
  }

  private tablesWithoutData(sql: string): string[] {
    const compiled = compile(sql, this.catalog);
    if (!compiled.ok) return [];
    const scanned = collectScannedTables(compiled.value.logicalPlan);
    for (const plan of compiled.value.logicalPlan._cteMap?.values() ?? []) collectScannedTables(plan, scanned);
    return [...scanned].filter(table => !this.hasData(table));
  }

  async run(sql: string): Promise<RunOutcome> {
    await this.ready;
    const missing = this.tablesWithoutData(sql);
    if (missing.length > 0) return { ok: false, reason: 'no-data', tables: missing };

    const startedAt = performance.now();
    try {
      const result = await this.engine.run(sql);
      const ms = performance.now() - startedAt;
      const rows = result.rows as ResultRow[];
      return {
        ok: true,
        columns: result.columns,
        rowKeys: 'rowKeys' in result && result.rowKeys ? result.rowKeys : result.columns,
        rows: rows.slice(0, RESULT_ROW_CAP),
        total: rows.length,
        truncated: rows.length > RESULT_ROW_CAP,
        ms,
      };
    } catch (error) {
      return { ok: false, reason: 'error', message: messageOf(error) };
    }
  }
}
