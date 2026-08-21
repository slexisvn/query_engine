import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import { Config, DataType, DEFAULT_CHUNK_SIZE, Table } from '../../index.js';
import { castToNumber } from '../../storage/data-type.js';
import { reconcileTypes } from '../../dataframe/type-inference.js';
import type { ColumnSchema, ColumnValue, QueryEngine } from '../../index.js';
import { DataLoader } from './data-loader.js';

interface CSVLoadOptions {
  partitionIndex?: number | null;
  partitionCount?: number | null;
  maxRows?: number | null;
}

type CSVRow = Record<string, string>;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

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

      let sample: CSVRow[] = [];

      const flushBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        await (table as Table).insertRows(batch);
        batch = [];
      };

      const materializeTable = (): void => {
        if (table) return;
        schema = this.inferSchema(sample);
        const pageStore = engine.storageBackend.createPageStore(engine.tempManager.allocate('buffer', tableName));
        table = new Table(tableName, schema, pageStore);
        this.registerToCatalog(engine, tableName, schema, table);
        for (const pending of sample) batch.push(this.convertRow(pending, schema));
        sample = [];
      };

      const fileStream = fs.createReadStream(resolvedPath);
      const stream = fileStream.pipe(csv());

      const finish = (): void => {
        if (done) return;
        done = true;
        fileStream.destroy();
        materializeTable();
        flushBatch().then(() => resolve(tableName)).catch(reject);
      };

      stream.on('data', (data: CSVRow) => {
        if (done) return;

        const currentRow = rowIndex++;
        if (maxRows !== null && currentRow >= maxRows) {
          finish();
          return;
        }
        if (usePartitionFilter && (currentRow % partitionCount) !== partitionIndex) {
          return;
        }

        if (!table) {
          sample.push(data);
          if (sample.length < Config.csvSchemaSampleRows) return;
          materializeTable();
        } else {
          batch.push(this.convertRow(data, schema as ColumnSchema[]));
        }

        if (batch.length >= DEFAULT_CHUNK_SIZE) {
          stream.pause();
          flushBatch().then(() => stream.resume()).catch(reject);
        }
      });

      stream.on('end', async () => {
        if (done) return;
        done = true;
        try {
          materializeTable();
          await flushBatch();
          resolve(tableName);
        } catch (err) {
          reject(err);
        }
      });

      stream.on('error', (err) => { if (!done) reject(err); });
    });
  }

  classifyValue(value: string): DataType | null {
    if (value === undefined || value === null || value.trim() === '') return null;
    const trimmed = value.trim();
    if (/^(true|false)$/i.test(trimmed)) return DataType.BOOLEAN;
    const numeric = castToNumber(trimmed);
    if (numeric === null) return DataType.VARCHAR;
    if (!Number.isInteger(numeric)) return DataType.FLOAT64;
    return numeric >= INT32_MIN && numeric <= INT32_MAX ? DataType.INT32 : DataType.INT64;
  }

  inferSchema(sample: CSVRow[]): ColumnSchema[] {
    const resolved = new Map<string, DataType | null>();
    for (const key of Object.keys(sample[0] ?? {})) resolved.set(key, null);
    for (const row of sample) {
      for (const [key, current] of resolved) {
        resolved.set(key, reconcileTypes(current, this.classifyValue(row[key])));
      }
    }
    return [...resolved].map(([name, dataType]) => ({ name, dataType: dataType ?? DataType.VARCHAR }));
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
        case DataType.FLOAT64: {
          const numeric = castToNumber(trimmed);
          row[i] = numeric === null ? null : (schema[i].dataType === DataType.INT32 ? Math.trunc(numeric) : numeric);
          break;
        }
        case DataType.INT64: {
          const numeric = castToNumber(trimmed);
          row[i] = numeric === null ? null : BigInt(Math.trunc(numeric));
          break;
        }
        default:
          row[i] = val;
          break;
      }
    }
    return row;
  }
}
