import { StatisticsCollector } from './statistics.js';
import type { TableStatistics } from './statistics.js';
import type { ColumnSchema, ColumnValue } from '../storage/data-type.js';

interface TableStorageLike {
  rowCount(): number;
  getSchema(): ColumnSchema[];
  getColumnIndex(name: string): number;
  scan(): AsyncIterable<{ size: number; getValue(row: number, col: number): ColumnValue }>;
}

interface CatalogLike {
  getTableStorage(name: string): TableStorageLike | null;
  listTables(): string[];
}

interface CacheEntry {
  stats: TableStatistics;
  version: number;
}

export class StatisticsCache {
  catalog: CatalogLike;
  cache: Map<string, CacheEntry>;
  versions: Map<string, number>;

  constructor(catalog: CatalogLike) {
    this.catalog = catalog;
    this.cache = new Map();
    this.versions = new Map();
  }

  get(tableName: string): TableStatistics | undefined {
    const key = tableName.toUpperCase();
    const entry = this.cache.get(key);
    if (entry && entry.version === this.getVersion(key)) {
      return entry.stats;
    }
    return undefined;
  }

  has(tableName: string): boolean {
    return this.get(tableName) !== undefined;
  }

  set(tableName: string, stats: TableStatistics): void {
    const key = tableName.toUpperCase();
    this.cache.set(key, { stats, version: this.getVersion(key) });
  }

  async ensure(tableName: string): Promise<TableStatistics | undefined> {
    const key = tableName.toUpperCase();
    const existing = this.get(key);
    if (existing) return existing;

    const storage = this.catalog.getTableStorage(key);
    if (!storage) return undefined;

    const stats: TableStatistics = await StatisticsCollector.collect(storage);
    this.set(key, stats);
    return stats;
  }

  async ensureAll(): Promise<void> {
    for (const name of this.catalog.listTables()) {
      await this.ensure(name);
    }
  }

  invalidate(tableName: string): void {
    const key = tableName.toUpperCase();
    this.versions.set(key, this.getVersion(key) + 1);
  }

  invalidateAll(): void {
    for (const key of this.cache.keys()) {
      this.invalidate(key);
    }
  }

  getVersion(key: string): number {
    return this.versions.get(key) || 0;
  }

  get size(): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (entry.version === this.getVersion(key)) count++;
    }
    return count;
  }

  *values(): Generator<TableStatistics> {
    for (const [key, entry] of this.cache) {
      if (entry.version === this.getVersion(key)) {
        yield entry.stats;
      }
    }
  }

  *entries(): Generator<[string, TableStatistics]> {
    for (const [key, entry] of this.cache) {
      if (entry.version === this.getVersion(key)) {
        yield [key, entry.stats];
      }
    }
  }

  [Symbol.iterator](): Generator<[string, TableStatistics]> {
    return this.entries();
  }

  toMap(): Map<string, TableStatistics> {
    const map = new Map<string, TableStatistics>();
    for (const [key, stats] of this) {
      map.set(key, stats);
    }
    return map;
  }
}
