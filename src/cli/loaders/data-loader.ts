import { DataType } from '../../index.js';
import type { ColumnSchema, QueryEngine, Table } from '../../index.js';

export class DataLoader {
  async load(engine: QueryEngine, filePath: string): Promise<string> {
    throw new Error('Method not implemented.');
  }

  registerToCatalog(engine: QueryEngine, tableName: string, schema: ColumnSchema[], table: Table): void {
    engine.catalog.registerTable(tableName, schema);
    engine.catalog.registerTableStorage(tableName, table);
  }

  buildSchema<T>(firstRow: Record<string, T>, classify: (value: T) => DataType): ColumnSchema[] {
    const schema: ColumnSchema[] = [];
    for (const [key, value] of Object.entries(firstRow)) {
      schema.push({ name: key, dataType: classify(value as T) });
    }
    return schema;
  }
}
