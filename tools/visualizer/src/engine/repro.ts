import { columnFactOf } from './column-facts.js';
import { describePhysicalNode } from '@engine/execution/physical-plan.js';
import { flattenProfile } from '@engine/execution/execution-profile.js';
import type { ExecutionProfile } from '@engine/execution/execution-profile.js';
import type { TableStats } from '@engine/catalog/statistics.js';
import type { ColumnValue } from '@engine/storage/data-type.js';
import type { RowCounts } from './demo-catalog.js';
import type { TableEntry, TableKind } from './workspace.js';

export const REPRO_VERSION = 1;

export interface ReproState {
  sql: string;
  rowCounts: RowCounts;
  disabled: string[];
}

export interface ReproColumn {
  name: string;
  dataType: string;
}

export interface ReproTable {
  name: string;
  kind: TableKind;
  estimatedRows: number;
  loadedRows: number;
  indexed: string[];
  columns: ReproColumn[];
}

export interface ReproColumnStats {
  column: string;
  ndv: number | null;
  nullFraction: number | null;
  min: ColumnValue;
  max: ColumnValue;
  histogramBuckets: number | null;
  mcvValues: number | null;
}

export interface ReproTableStats {
  table: string;
  rowCount: number;
  columns: ReproColumnStats[];
}

export interface ReproOperator {
  operator: string;
  estimatedRows: number;
  actualRows: number;
}

export interface ReproBundle extends ReproState {
  version: number;
  tables: ReproTable[];
  statistics: ReproTableStats[];
  measured: ReproOperator[] | null;
}

export interface ReproInput {
  sql: string;
  rowCounts: RowCounts;
  disabled: ReadonlySet<string>;
  tables: readonly TableEntry[];
  statistics: Map<string, TableStats>;
  profile: ExecutionProfile | null;
}

function statsOf(table: TableEntry, statistics: Map<string, TableStats>): ReproTableStats | null {
  const forTable = statistics.get(table.name.toUpperCase());
  if (!forTable) return null;

  return {
    table: table.name,
    rowCount: forTable.rowCount,
    columns: table.columns.map(column => {
      const fact = columnFactOf(statistics, table.name, column.name);
      return {
        column: column.name,
        ndv: fact.ndv,
        nullFraction: fact.nullFraction,
        min: fact.min,
        max: fact.max,
        histogramBuckets: fact.histogramBuckets,
        mcvValues: fact.mcvValues,
      };
    }),
  };
}

function measuredOf(profile: ExecutionProfile | null): ReproOperator[] | null {
  if (profile === null) return null;
  return flattenProfile(profile.roots).map(entry => ({
    operator: describePhysicalNode(entry.node),
    estimatedRows: entry.estimatedRows,
    actualRows: entry.actualRows,
  }));
}

export function buildRepro(input: ReproInput): ReproBundle {
  return {
    version: REPRO_VERSION,
    sql: input.sql,
    rowCounts: input.rowCounts,
    disabled: [...input.disabled],
    tables: input.tables.map(table => ({
      name: table.name,
      kind: table.kind,
      estimatedRows: table.rowCount,
      loadedRows: table.dataRows,
      indexed: [...table.indexed],
      columns: table.columns.map(column => ({ name: column.name, dataType: String(column.dataType) })),
    })),
    statistics: input.tables
      .map(table => statsOf(table, input.statistics))
      .filter((entry): entry is ReproTableStats => entry !== null),
    measured: measuredOf(input.profile),
  };
}

export function serializeRepro(bundle: ReproBundle): string {
  return JSON.stringify(bundle, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2);
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeState(state: ReproState): string {
  return toBase64Url(JSON.stringify(state));
}

function isRowCounts(value: unknown): value is RowCounts {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every(entry => typeof entry === 'number' && Number.isFinite(entry));
}

export function decodeState(encoded: string): ReproState | null {
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(encoded));
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { sql, rowCounts, disabled } = parsed as { sql?: unknown; rowCounts?: unknown; disabled?: unknown };
    if (typeof sql !== 'string' || !isRowCounts(rowCounts)) return null;
    if (disabled !== undefined && !(Array.isArray(disabled) && disabled.every(name => typeof name === 'string'))) {
      return null;
    }

    return { sql, rowCounts, disabled: (disabled as string[] | undefined) ?? [] };
  } catch {
    return null;
  }
}
