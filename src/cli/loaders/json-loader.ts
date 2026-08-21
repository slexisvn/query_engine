import { createReadStream } from 'fs';
import path from 'path';
import { Config, DataType, DEFAULT_CHUNK_SIZE, Table } from '../../index.js';
import type { ColumnSchema, ColumnValue, QueryEngine } from '../../index.js';
import { DataLoader } from './data-loader.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

export class JSONLoader extends DataLoader {
  override async load(engine: QueryEngine, filePath: string): Promise<string> {
    const tableName = path.basename(filePath, path.extname(filePath)).toUpperCase();

    let schema: ColumnSchema[] | null = null;
    let table: Table | null = null;
    let batch: ColumnValue[][] = [];

    for await (const obj of streamJsonArray(filePath)) {
      if (!schema) {
        schema = this.inferSchema(obj);
        const pageStore = engine.storageBackend.createPageStore(engine.tempManager.allocate('buffer', tableName));
        table = new Table(tableName, schema, pageStore);
        this.registerToCatalog(engine, tableName, schema, table);
      }

      const row: ColumnValue[] = new Array(schema.length);
      for (let c = 0; c < schema.length; c++) {
        const val = obj[schema[c].name];
        row[c] = val === undefined ? null : (val as ColumnValue);
      }
      batch.push(row);

      if (batch.length >= DEFAULT_CHUNK_SIZE) {
        await (table as Table).insertRows(batch);
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

  inferSchema(firstRow: JsonObject): ColumnSchema[] {
    return this.buildSchema(firstRow, (value: JsonValue) => {
      let type = DataType.VARCHAR;
      if (typeof value === 'boolean') {
        type = DataType.BOOLEAN;
      } else if (typeof value === 'number') {
        type = Number.isInteger(value) ? DataType.INT32 : DataType.FLOAT64;
      }
      return type;
    });
  }
}

async function* streamJsonArray(filePath: string): AsyncGenerator<JsonObject> {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: Config.jsonReadBufferBytes });
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
          yield JSON.parse(buffer.substring(objectStart, i + 1)) as JsonObject;
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
