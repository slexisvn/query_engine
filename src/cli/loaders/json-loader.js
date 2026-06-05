import { createReadStream } from 'fs';
import path from 'path';
import { DataType } from '../../storage/data-type.js';
import { Table } from '../../storage/table.js';
import { DEFAULT_CHUNK_SIZE } from '../../storage/chunk.js';
import { DataLoader } from './data-loader.js';

export class JSONLoader extends DataLoader {
  async load(engine, filePath) {
    const tableName = path.basename(filePath, path.extname(filePath)).toUpperCase();

    let schema = null;
    let table = null;
    let batch = [];

    for await (const obj of streamJsonArray(filePath)) {
      if (!schema) {
        schema = this.inferSchema(obj);
        const bufferPath = engine.tempManager.allocate('buffer', tableName);
        table = new Table(tableName, schema, bufferPath);
        this.registerToCatalog(engine, tableName, schema, table);
      }

      const row = new Array(schema.length);
      for (let c = 0; c < schema.length; c++) {
        const val = obj[schema[c].name];
        row[c] = val === undefined ? null : val;
      }
      batch.push(row);

      if (batch.length >= DEFAULT_CHUNK_SIZE) {
        await table.insertRows(batch);
        batch = [];
      }
    }

    if (!table) {
      throw new Error('JSON array is empty.');
    }

    if (batch.length > 0) {
      await table.insertRows(batch);
    }

    return tableName;
  }

  inferSchema(firstRow) {
    const schema = [];
    for (const [key, value] of Object.entries(firstRow)) {
      let type = DataType.VARCHAR;
      if (typeof value === 'boolean') {
        type = DataType.BOOLEAN;
      } else if (typeof value === 'number') {
        type = Number.isInteger(value) ? DataType.INT32 : DataType.FLOAT64;
      }
      schema.push({ name: key, dataType: type });
    }
    return schema;
  }
}

async function* streamJsonArray(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let depth = 0;
  let inString = false;
  let escape = false;
  let objectStart = -1;
  let buffer = '';
  let scanFrom = 0;
  let seenArrayOpen = false;

  for await (const chunk of stream) {
    scanFrom = buffer.length;
    buffer += chunk;

    let i = scanFrom;
    while (i < buffer.length) {
      const ch = buffer[i];

      if (escape) {
        escape = false;
        i++;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        i++;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        i++;
        continue;
      }

      if (inString) {
        i++;
        continue;
      }

      if (!seenArrayOpen) {
        if (ch === '[') seenArrayOpen = true;
        i++;
        continue;
      }

      if (ch === '{') {
        if (depth === 0) objectStart = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && objectStart !== -1) {
          yield JSON.parse(buffer.substring(objectStart, i + 1));
          objectStart = -1;
        }
      }

      i++;
    }

    if (objectStart !== -1) {
      buffer = buffer.substring(objectStart);
      objectStart = 0;
    } else {
      buffer = '';
    }
  }
}
