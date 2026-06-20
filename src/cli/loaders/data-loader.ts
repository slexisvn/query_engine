import type { QueryEngine } from '../../engine/query-engine.js';
import type { ColumnSchema } from '../../storage/data-type.js';
import type { Table } from '../../storage/table.js';

export class DataLoader {
  async load(engine: QueryEngine, filePath: string): Promise<string> {
    throw new Error('Method not implemented.');
  }

  registerToCatalog(engine: QueryEngine, tableName: string, schema: ColumnSchema[], table: Table): void {
    engine.catalog.registerTable(tableName, schema);
    engine.catalog.registerTableStorage(tableName, table);
  }
}
