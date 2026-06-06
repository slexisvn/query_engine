import { StatisticsCollector } from './statistics.js';

export class StatisticsCache {
  constructor(catalog) {
    this.catalog = catalog;
    this.cache = new Map();
    this.versions = new Map();
  }

  get(tableName) {
    const key = tableName.toUpperCase();
    const entry = this.cache.get(key);
    if (entry && entry.version === this.getVersion(key)) {
      return entry.stats;
    }
    return undefined;
  }

  has(tableName) {
    return this.get(tableName) !== undefined;
  }

  set(tableName, stats) {
    const key = tableName.toUpperCase();
    this.cache.set(key, { stats, version: this.getVersion(key) });
  }

  async ensure(tableName) {
    const key = tableName.toUpperCase();
    const existing = this.get(key);
    if (existing) return existing;

    const storage = this.catalog.getTableStorage(key);
    if (!storage) return undefined;

    const stats = await StatisticsCollector.collect(storage);
    this.set(key, stats);
    return stats;
  }

  async ensureAll() {
    for (const name of this.catalog.listTables()) {
      await this.ensure(name);
    }
  }

  invalidate(tableName) {
    const key = tableName.toUpperCase();
    this.versions.set(key, this.getVersion(key) + 1);
  }

  invalidateAll() {
    for (const key of this.cache.keys()) {
      this.invalidate(key);
    }
  }

  getVersion(key) {
    return this.versions.get(key) || 0;
  }

  get size() {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (entry.version === this.getVersion(key)) count++;
    }
    return count;
  }

  *values() {
    for (const [key, entry] of this.cache) {
      if (entry.version === this.getVersion(key)) {
        yield entry.stats;
      }
    }
  }

  *entries() {
    for (const [key, entry] of this.cache) {
      if (entry.version === this.getVersion(key)) {
        yield [key, entry.stats];
      }
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  toMap() {
    const map = new Map();
    for (const [key, stats] of this) {
      map.set(key, stats);
    }
    return map;
  }
}
