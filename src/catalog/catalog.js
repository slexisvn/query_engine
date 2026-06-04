export class Catalog {
  constructor() {
    this.tables = new Map();
    this.tableStorage = new Map();
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

  hasTable(name) {
    return this.tables.has(name.toUpperCase());
  }

  listTables() {
    return Array.from(this.tables.keys());
  }
}
