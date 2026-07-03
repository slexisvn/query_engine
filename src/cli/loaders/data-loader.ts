import type { QueryEngine } from '../../engine/query-engine.js';
import { DataType } from '../../storage/data-type.js';
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

  buildSchema<T>(firstRow: Record<string, T>, classify: (value: T) => DataType): ColumnSchema[] {
    const schema: ColumnSchema[] = [];
    for (const [key, value] of Object.entries(firstRow)) {
      schema.push({ name: key, dataType: classify(value as T) });
    }
    return schema;
  }
}
