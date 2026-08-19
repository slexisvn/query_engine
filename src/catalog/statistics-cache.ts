import type { TableStorage } from '../storage/table-storage.js';
import { StatisticsCollector } from './statistics.js';
import type { TableStatistics } from './statistics.js';
import type { ColumnSchema, ColumnValue } from '../storage/data-type.js';

interface CatalogLike {
  getTableStorage(name: string): TableStorage | null;
  listTables(): string[];
}

interface CacheEntry {
  stats: TableStatistics;
  source: TableStorage | null;
  rowCount: number;
}

export class StatisticsCache {
  catalog: CatalogLike;
  cache: Map<string, CacheEntry>;
  generation: number;

  constructor(catalog: CatalogLike) {
    this.catalog = catalog;
    this.cache = new Map();
    this.generation = 0;
  }

  get(tableName: string): TableStatistics | undefined {
    const key = tableName.toUpperCase();
    const entry = this.cache.get(key);
    return entry && this.describesCurrentData(key, entry) ? entry.stats : undefined;
  }

  describesCurrentData(key: string, entry: CacheEntry): boolean {
    if (entry.source === null) return true;
    const storage = this.catalog.getTableStorage(key);
    return storage === entry.source && storage.rowCount() === entry.rowCount;
  }

  has(tableName: string): boolean {
    return this.get(tableName) !== undefined;
  }

  set(tableName: string, stats: TableStatistics): void {
    const key = tableName.toUpperCase();
    const source = this.catalog.getTableStorage(key);
    this.cache.set(key, { stats, source, rowCount: source ? source.rowCount() : 0 });
    this.generation++;
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

  async ensureFor(tableNames: Iterable<string>): Promise<void> {
    for (const name of tableNames) {
      await this.ensure(name);
    }
  }

  invalidate(tableName: string): void {
    if (this.cache.delete(tableName.toUpperCase())) this.generation++;
  }

  invalidateAll(): void {
    for (const key of [...this.cache.keys()]) {
      this.invalidate(key);
    }
  }

  get size(): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (this.describesCurrentData(key, entry)) count++;
    }
    return count;
  }

  *values(): Generator<TableStatistics> {
    for (const [key, entry] of this.cache) {
      if (this.describesCurrentData(key, entry)) yield entry.stats;
    }
  }

  *entries(): Generator<[string, TableStatistics]> {
    for (const [key, entry] of this.cache) {
      if (this.describesCurrentData(key, entry)) yield [key, entry.stats];
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
