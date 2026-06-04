import fs from 'fs/promises';
import path from 'path';
import { DataType } from '../../storage/data-type.js';
import { Table } from '../../storage/table.js';
import { DataLoader } from './data-loader.js';

export class JSONLoader extends DataLoader {
  async load(engine, filePath) {
    const tableName = path.basename(filePath, path.extname(filePath)).toUpperCase();
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);

    if (!Array.isArray(data)) {
      throw new Error('JSON loader requires an array of objects.');
    }

    if (data.length === 0) {
      throw new Error('JSON array is empty.');
    }

    const schema = this.inferSchema(data[0]);
    const table = new Table(tableName, schema);
    this.registerToCatalog(engine, tableName, schema, table);

    const rows = data.map(obj => this.convertRow(obj, schema));
    await table.insertRows(rows);

    return tableName;
  }

  inferSchema(firstRow) {
    const schema = [];
    for (const [key, value] of Object.entries(firstRow)) {
      let type = DataType.VARCHAR;
      if (typeof value === 'boolean') {
        type = DataType.BOOLEAN;
      } else if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          type = DataType.INT32;
        } else {
          type = DataType.FLOAT64;
        }
      }
      schema.push({ name: key, dataType: type });
    }
    return schema;
  }

  convertRow(rowObj, schema) {
    return schema.map(col => {
      const val = rowObj[col.name];
      if (val === undefined || val === null) {
        return null;
      }
      return val;
    });
  }
}
