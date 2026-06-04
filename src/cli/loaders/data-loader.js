export class DataLoader {
  async load(engine, filePath) {
    throw new Error('Method not implemented.');
  }

  registerToCatalog(engine, tableName, schema, table) {
    engine.catalog.registerTable(tableName, schema);
    engine.catalog.registerTableStorage(tableName, table);
  }
}
