import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import { DataType } from '../../storage/data-type.js';
import type { ColumnSchema, ColumnValue } from '../../storage/data-type.js';
import { Table } from '../../storage/table.js';
import { DEFAULT_CHUNK_SIZE } from '../../storage/chunk.js';
import { DataLoader } from './data-loader.js';
import type { QueryEngine } from '../../engine/query-engine.js';

interface CSVLoadOptions {
  partitionIndex?: number | null;
  partitionCount?: number | null;
  maxRows?: number | null;
}

type CSVRow = Record<string, string>;

export class CSVLoader extends DataLoader {
  allowedDir: string | null;

  constructor(allowedDir: string | null = null) {
    super();
    this.allowedDir = allowedDir;
  }

  validatePath(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (this.allowedDir) {
      const allowedResolved = path.resolve(this.allowedDir);
      if (!resolved.startsWith(allowedResolved + path.sep) && resolved !== allowedResolved) {
        throw new Error(`Path traversal denied: ${filePath} is outside allowed directory`);
      }
    }
    if (/\.\.[/\\]/.test(filePath)) {
      const cwd = process.cwd();
      if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
        throw new Error(`Path traversal denied: ${filePath} resolves outside working directory`);
      }
    }
    return resolved;
  }

  override async load(engine: QueryEngine, filePath: string, options: CSVLoadOptions = {}): Promise<string> {
    const resolvedPath = this.validatePath(filePath);
    const partitionIndex = options.partitionIndex ?? null;
    const partitionCount = options.partitionCount ?? null;
    const usePartitionFilter = partitionIndex !== null && partitionCount !== null;
    const maxRows = options.maxRows ?? null;

    return new Promise<string>((resolve, reject) => {
      const tableName = path.basename(resolvedPath, path.extname(resolvedPath)).toUpperCase();
      let schema: ColumnSchema[] | null = null;
      let table: Table | null = null;
      let batch: ColumnValue[][] = [];
      let rowIndex = 0;
      let done = false;

      const flushBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        await (table as Table).insertRows(batch);
        batch = [];
      };

      const fileStream = fs.createReadStream(resolvedPath);
      const stream = fileStream.pipe(csv());

      const finish = (): void => {
        if (done) return;
        done = true;
        fileStream.destroy();
        flushBatch().then(() => resolve(tableName)).catch(reject);
      };

      stream.on('data', (data: CSVRow) => {
        if (done) return;
        if (!schema) {
          schema = this.inferSchema(data);
          const pageStore = engine.storageBackend.createPageStore(engine.tempManager.allocate('buffer', tableName));
          table = new Table(tableName, schema, pageStore);
          this.registerToCatalog(engine, tableName, schema, table);
        }

        const currentRow = rowIndex++;
        if (maxRows !== null && currentRow >= maxRows) {
          finish();
          return;
        }
        if (usePartitionFilter && (currentRow % partitionCount) !== partitionIndex) {
          return;
        }

        batch.push(this.convertRow(data, schema));
        if (batch.length >= DEFAULT_CHUNK_SIZE) {
          stream.pause();
          flushBatch().then(() => stream.resume()).catch(reject);
        }
      });

      stream.on('end', async () => {
        if (done) return;
        done = true;
        try {
          await flushBatch();
          resolve(tableName);
        } catch (err) {
          reject(err);
        }
      });

      stream.on('error', (err) => { if (!done) reject(err); });
    });
  }

  inferSchema(firstRow: CSVRow): ColumnSchema[] {
    const schema: ColumnSchema[] = [];
    for (const [key, value] of Object.entries(firstRow)) {
      let type = DataType.VARCHAR;
      if (value && value.trim() !== '') {
        const trimmed = value.trim();
        if (/^(true|false)$/i.test(trimmed)) {
          type = DataType.BOOLEAN;
        } else if (!isNaN(Number(trimmed))) {
          type = Number.isInteger(Number(trimmed)) ? DataType.INT32 : DataType.FLOAT64;
        }
      }
      schema.push({ name: key, dataType: type });
    }
    return schema;
  }

  convertRow(rowObj: CSVRow, schema: ColumnSchema[]): ColumnValue[] {
    const row: ColumnValue[] = new Array(schema.length);
    for (let i = 0; i < schema.length; i++) {
      const val = rowObj[schema[i].name];
      if (val === undefined || val === null || val === '') {
        row[i] = null;
        continue;
      }
      const trimmed = typeof val === 'string' ? val.trim() : val;
      if (trimmed === '') {
        row[i] = null;
        continue;
      }
      switch (schema[i].dataType) {
        case DataType.BOOLEAN:
          row[i] = trimmed.toLowerCase() === 'true';
          break;
        case DataType.INT32:
          row[i] = parseInt(trimmed, 10);
          break;
        case DataType.FLOAT64:
          row[i] = parseFloat(trimmed);
          break;
        default:
          row[i] = val;
          break;
      }
    }
    return row;
  }
}
