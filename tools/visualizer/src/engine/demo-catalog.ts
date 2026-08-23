import { createTPCHCatalog, TPCH_TABLES } from '@engine/catalog/tpch-schema.js';
import { BTreeIndex } from '@engine/storage/btree.js';
import { ColumnStatistics, TableStatistics } from '@engine/catalog/statistics.js';
import { byteWidthFor, dateToEpochDays, DataType } from '@engine/storage/data-type.js';
import type { Catalog } from '@engine/catalog/catalog.js';
import type { TableStats } from '@engine/catalog/statistics.js';
import type { ColumnSchema, ColumnValue } from '@engine/storage/data-type.js';

export type RowCounts = Readonly<Record<string, number>>;

export const DEFAULT_ROW_COUNTS: RowCounts = {
  REGION: 5,
  NATION: 25,
  SUPPLIER: 10_000,
  PART: 200_000,
  PARTSUPP: 800_000,
  CUSTOMER: 150_000,
  ORDERS: 1_500_000,
  LINEITEM: 6_001_215,
};

const CALENDAR_START = dateToEpochDays(1992, 1, 1);
const CALENDAR_END = dateToEpochDays(1998, 12, 31);
const SHIPPING_END = dateToEpochDays(1998, 8, 2);

interface ColumnSpec {
  ndv?: number;
  ndvRatio?: number;
  min?: ColumnValue;
  max?: ColumnValue;
  avgLength?: number;
}

const COLUMN_SPECS: Readonly<Record<string, ColumnSpec>> = {
  R_NAME: { ndv: 5, avgLength: 7 },
  R_COMMENT: { ndv: 5, avgLength: 66 },

  N_NAME: { ndv: 25, avgLength: 8 },
  N_COMMENT: { ndv: 25, avgLength: 74 },

  S_NAME: { ndvRatio: 1, avgLength: 18 },
  S_ADDRESS: { ndvRatio: 1, avgLength: 25 },
  S_PHONE: { ndvRatio: 1, avgLength: 15 },
  S_ACCTBAL: { ndvRatio: 0.9, min: -999.99, max: 9999.99 },
  S_COMMENT: { ndvRatio: 1, avgLength: 63 },

  P_NAME: { ndvRatio: 1, avgLength: 33 },
  P_MFGR: { ndv: 5, avgLength: 14 },
  P_BRAND: { ndv: 25, avgLength: 8 },
  P_TYPE: { ndv: 150, avgLength: 21 },
  P_SIZE: { ndv: 50, min: 1, max: 50 },
  P_CONTAINER: { ndv: 40, avgLength: 8 },
  P_RETAILPRICE: { ndvRatio: 0.1, min: 901, max: 2098.99 },
  P_COMMENT: { ndvRatio: 0.65, avgLength: 14 },

  PS_AVAILQTY: { ndv: 9999, min: 1, max: 9999 },
  PS_SUPPLYCOST: { ndvRatio: 0.12, min: 1, max: 1000 },
  PS_COMMENT: { ndvRatio: 1, avgLength: 124 },

  C_NAME: { ndvRatio: 1, avgLength: 18 },
  C_ADDRESS: { ndvRatio: 1, avgLength: 25 },
  C_PHONE: { ndvRatio: 1, avgLength: 15 },
  C_ACCTBAL: { ndvRatio: 0.9, min: -999.99, max: 9999.99 },
  C_MKTSEGMENT: { ndv: 5, avgLength: 9 },
  C_COMMENT: { ndvRatio: 1, avgLength: 73 },

  O_ORDERSTATUS: { ndv: 3, avgLength: 1 },
  O_TOTALPRICE: { ndvRatio: 0.9, min: 857, max: 555_285.16 },
  O_ORDERDATE: { ndv: 2406, min: CALENDAR_START, max: SHIPPING_END },
  O_ORDERPRIORITY: { ndv: 5, avgLength: 15 },
  O_CLERK: { ndv: 1000, avgLength: 15 },
  O_SHIPPRIORITY: { ndv: 1, min: 0, max: 0 },
  O_COMMENT: { ndvRatio: 0.9, avgLength: 49 },

  L_LINENUMBER: { ndv: 7, min: 1, max: 7 },
  L_QUANTITY: { ndv: 50, min: 1, max: 50 },
  L_EXTENDEDPRICE: { ndvRatio: 0.15, min: 901, max: 104_949.5 },
  L_DISCOUNT: { ndv: 11, min: 0, max: 0.1 },
  L_TAX: { ndv: 9, min: 0, max: 0.08 },
  L_RETURNFLAG: { ndv: 3, avgLength: 1 },
  L_LINESTATUS: { ndv: 2, avgLength: 1 },
  L_SHIPDATE: { ndv: 2526, min: CALENDAR_START, max: SHIPPING_END },
  L_COMMITDATE: { ndv: 2466, min: CALENDAR_START, max: CALENDAR_END },
  L_RECEIPTDATE: { ndv: 2554, min: CALENDAR_START, max: CALENDAR_END },
  L_SHIPINSTRUCT: { ndv: 4, avgLength: 12 },
  L_SHIPMODE: { ndv: 7, avgLength: 4 },
  L_COMMENT: { ndvRatio: 0.7, avgLength: 27 },
};

function foreignKeyTarget(tableName: string, columnName: string): string | null {
  const foreignKeys = TPCH_TABLES[tableName]?.foreignKeys ?? [];
  for (const key of foreignKeys) {
    const position = key.columns.indexOf(columnName);
    if (position !== -1) return key.refTable;
  }
  return null;
}

function isSoleKeyColumn(tableName: string, columnName: string): boolean {
  const primaryKey = TPCH_TABLES[tableName]?.primaryKey ?? [];
  return primaryKey.length === 1 && primaryKey[0] === columnName;
}

function distinctCount(tableName: string, columnName: string, rowCounts: RowCounts): number {
  const rowCount = rowCounts[tableName] ?? 0;
  const spec = COLUMN_SPECS[columnName];

  if (spec?.ndv !== undefined) return Math.max(1, Math.min(spec.ndv, rowCount));
  if (spec?.ndvRatio !== undefined) return Math.max(1, Math.round(rowCount * spec.ndvRatio));

  const referenced = foreignKeyTarget(tableName, columnName);
  if (referenced !== null) return Math.max(1, Math.min(rowCount, rowCounts[referenced] ?? rowCount));

  if (isSoleKeyColumn(tableName, columnName)) return Math.max(1, rowCount);
  return Math.max(1, rowCount);
}

function keyBounds(tableName: string, columnName: string, rowCounts: RowCounts): ColumnSpec {
  if (!isSoleKeyColumn(tableName, columnName)) return {};
  return { min: 1, max: Math.max(1, rowCounts[tableName] ?? 1) };
}

function columnStatisticsFor(tableName: string, column: ColumnSchema, rowCounts: RowCounts): ColumnStatistics {
  const spec = COLUMN_SPECS[column.name] ?? keyBounds(tableName, column.name, rowCounts);
  return new ColumnStatistics({
    ndv: distinctCount(tableName, column.name, rowCounts),
    min: spec.min ?? null,
    max: spec.max ?? null,
    nullFraction: 0,
    avgWidth: column.dataType === DataType.VARCHAR ? (spec.avgLength ?? 25) : byteWidthFor(column.dataType),
    avgLength: column.dataType === DataType.VARCHAR ? (spec.avgLength ?? 25) : null,
  });
}

export const INDEXED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  REGION: ['R_REGIONKEY'],
  NATION: ['N_NATIONKEY'],
  SUPPLIER: ['S_SUPPKEY'],
  PART: ['P_PARTKEY'],
  CUSTOMER: ['C_CUSTKEY'],
  ORDERS: ['O_ORDERKEY', 'O_ORDERDATE'],
  LINEITEM: ['L_ORDERKEY', 'L_SHIPDATE'],
};

export function registerSampleTables(catalog: Catalog): void {
  for (const [name, table] of Object.entries(TPCH_TABLES)) {
    catalog.registerTable(name, table.columns, {
      primaryKey: table.primaryKey,
      foreignKeys: table.foreignKeys ?? [],
    });
  }

  for (const [tableName, columns] of Object.entries(INDEXED_COLUMNS)) {
    for (const columnName of columns) {
      const column = TPCH_TABLES[tableName].columns.find(candidate => candidate.name === columnName);
      if (column) catalog.registerIndex(tableName, columnName, new BTreeIndex(column.dataType));
    }
  }
}

export function dropSampleTables(catalog: Catalog): void {
  for (const name of Object.keys(TPCH_TABLES)) catalog.dropTable(name);
}

export function createDemoCatalog(): Catalog {
  const catalog = createTPCHCatalog();
  registerSampleTables(catalog);
  return catalog;
}

export function buildStatistics(rowCounts: RowCounts): Map<string, TableStats> {
  const statistics = new Map<string, TableStats>();

  for (const [tableName, table] of Object.entries(TPCH_TABLES)) {
    const rowCount = rowCounts[tableName] ?? 0;
    const columnStats = new Map<string, ColumnStatistics>();
    for (const column of table.columns) {
      columnStats.set(column.name, columnStatisticsFor(tableName, column, rowCounts));
    }
    statistics.set(tableName, new TableStatistics(rowCount, columnStats));
  }

  return statistics;
}

export const DEMO_SCHEMA: Readonly<Record<string, string[]>> = Object.fromEntries(
  Object.entries(TPCH_TABLES).map(([name, table]) => [name, table.columns.map(column => column.name)]),
);
