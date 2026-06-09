export class Catalog {
  constructor() {
    this.tables = new Map();
    this.tableStorage = new Map();
    this.indexes = new Map();
    this.partitionInfo = new Map();
  }

  registerTable(name, schema, options = {}) {
    const upperName = name.toUpperCase();
    this.tables.set(upperName, {
      name: upperName,
      columns: schema,
      primaryKey: options.primaryKey || [],
      foreignKeys: options.foreignKeys || [],
    });
  }

  registerTableStorage(name, storage) {
    this.tableStorage.set(name.toUpperCase(), storage);
  }

  getTable(name) {
    return this.tables.get(name.toUpperCase()) || null;
  }

  getTableStorage(name) {
    return this.tableStorage.get(name.toUpperCase()) || null;
  }

  getColumn(tableName, columnName) {
    const table = this.getTable(tableName);
    if (!table) return null;
    const upper = columnName.toUpperCase();
    return table.columns.find(c => c.name.toUpperCase() === upper) || null;
  }

  getColumnIndex(tableName, columnName) {
    const table = this.getTable(tableName);
    if (!table) return -1;
    const upper = columnName.toUpperCase();
    return table.columns.findIndex(c => c.name.toUpperCase() === upper);
  }

  dropTable(name) {
    const upper = name.toUpperCase();
    this.tables.delete(upper);
    this.tableStorage.delete(upper);
    for (const [key, entry] of this.indexes) {
      if (entry.tableName === upper) this.indexes.delete(key);
    }
  }

  hasTable(name) {
    return this.tables.has(name.toUpperCase());
  }

  listTables() {
    return Array.from(this.tables.keys());
  }

  registerIndex(tableName, columnName, btree) {
    const key = `${tableName.toUpperCase()}.${columnName.toUpperCase()}`;
    this.indexes.set(key, { tableName: tableName.toUpperCase(), columnName: columnName.toUpperCase(), btree });
  }

  getIndexForColumn(tableName, columnName) {
    const key = `${tableName.toUpperCase()}.${columnName.toUpperCase()}`;
    const entry = this.indexes.get(key);
    return entry ? entry.btree : null;
  }

  getIndexesForTable(tableName) {
    const upper = tableName.toUpperCase();
    const result = [];
    for (const entry of this.indexes.values()) {
      if (entry.tableName === upper) result.push(entry);
    }
    return result;
  }

  registerPartitionInfo(tableName, strategy, partitionCount, partitionKey) {
    this.partitionInfo.set(tableName.toUpperCase(), { strategy, partitionCount, partitionKey });
  }

  getPartitionInfo(tableName) {
    return this.partitionInfo.get(tableName.toUpperCase()) || null;
  }
}
