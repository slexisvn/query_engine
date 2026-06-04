import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import { DataType } from '../../storage/data-type.js';
import { Table } from '../../storage/table.js';
import { DataLoader } from './data-loader.js';

export class CSVLoader extends DataLoader {
  async load(engine, filePath) {
    return new Promise((resolve, reject) => {
      const tableName = path.basename(filePath, path.extname(filePath)).toUpperCase();
      const rows = [];
      let schema = null;
      let table = null;

      fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (data) => {
          if (!schema) {
            schema = this.inferSchema(data);
            table = new Table(tableName, schema);
            this.registerToCatalog(engine, tableName, schema, table);
          }
          rows.push(this.convertRow(data, schema));
        })
        .on('end', async () => {
          if (table && rows.length > 0) {
            await table.insertRows(rows);
          }
          resolve(tableName);
        })
        .on('error', reject);
    });
  }

  inferSchema(firstRow) {
    const schema = [];
    for (const [key, value] of Object.entries(firstRow)) {
      let type = DataType.VARCHAR;
      if (value && value.trim() !== '') {
        const trimmed = value.trim();
        if (/^(true|false)$/i.test(trimmed)) {
          type = DataType.BOOLEAN;
        } else if (!isNaN(Number(trimmed))) {
          if (Number.isInteger(Number(trimmed))) {
            type = DataType.INT32;
          } else {
            type = DataType.FLOAT64;
          }
        }
      }
      schema.push({ name: key, dataType: type });
    }
    return schema;
  }

  convertRow(rowObj, schema) {
    return schema.map(col => {
      const val = rowObj[col.name];
      if (val === undefined || val === null || val.trim() === '') {
        return null;
      }
      const trimmed = val.trim();
      switch (col.dataType) {
        case DataType.BOOLEAN:
          return trimmed.toLowerCase() === 'true';
        case DataType.INT32:
          return parseInt(trimmed, 10);
        case DataType.FLOAT64:
          return parseFloat(trimmed);
        default:
          return val;
      }
    });
  }
}
