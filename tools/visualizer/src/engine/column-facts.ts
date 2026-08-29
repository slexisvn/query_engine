import type { ColumnStats, TableStats } from '@engine/catalog/statistics.js';
import type { ColumnValue } from '@engine/storage/data-type.js';

export interface ColumnFact {
  table: string;
  column: string;
  known: boolean;
  ndv: number | null;
  nullFraction: number | null;
  min: ColumnValue;
  max: ColumnValue;
  histogramBuckets: number | null;
  mcvValues: number | null;
  indexed: boolean;
  dataType: string | null;
}

function statsFor(statistics: Map<string, TableStats>, table: string, column: string): ColumnStats | null {
  const forTable = statistics.get(table.toUpperCase());
  if (!forTable) return null;

  const upper = column.toUpperCase();
  return forTable.getColumnStats?.(upper) ?? forTable.columnStats?.get(upper) ?? null;
}

export function indexKey(table: string, column: string): string {
  return `${table.toUpperCase()}.${column.toUpperCase()}`;
}

export function columnFactOf(
  statistics: Map<string, TableStats>,
  table: string,
  column: string,
  indexed: ReadonlySet<string> = new Set(),
  dataType: string | null = null,
): ColumnFact {
  const stats = statsFor(statistics, table, column);

  return {
    table: table.toUpperCase(),
    column: column.toUpperCase(),
    known: stats !== null,
    indexed: indexed.has(indexKey(table, column)),
    dataType,
    ndv: stats?.ndv ?? null,
    nullFraction: stats?.nullFraction ?? null,
    min: stats?.min ?? null,
    max: stats?.max ?? null,
    histogramBuckets: stats?.histogram?.numBuckets ?? null,
    mcvValues: stats?.mcv?.values.length ?? null,
  };
}

export function qualifiedName(fact: ColumnFact): string {
  return `${fact.table}.${fact.column}`;
}
