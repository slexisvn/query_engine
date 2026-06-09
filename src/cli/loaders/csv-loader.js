import fs from 'fs';
import csv from 'csv-parser';
import path from 'path';
import { DataType } from '../../storage/data-type.js';
import { Table } from '../../storage/table.js';
import { DEFAULT_CHUNK_SIZE } from '../../storage/chunk.js';
import { DataLoader } from './data-loader.js';

export class CSVLoader extends DataLoader {
  constructor(allowedDir = null) {
    super();
    this.allowedDir = allowedDir;
  }

  validatePath(filePath) {
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

  async load(engine, filePath, options = {}) {
    const resolvedPath = this.validatePath(filePath);
    const partitionIndex = options.partitionIndex ?? null;
    const partitionCount = options.partitionCount ?? null;
    const usePartitionFilter = partitionIndex !== null && partitionCount !== null;

    return new Promise((resolve, reject) => {
      const tableName = path.basename(resolvedPath, path.extname(resolvedPath)).toUpperCase();
      let schema = null;
      let table = null;
      let batch = [];
      let rowIndex = 0;

      const flushBatch = async () => {
        if (batch.length === 0) return;
        await table.insertRows(batch);
        batch = [];
      };

      const stream = fs.createReadStream(resolvedPath).pipe(csv());

      stream.on('data', (data) => {
        if (!schema) {
          schema = this.inferSchema(data);
          const bufferPath = engine.tempManager.allocate('buffer', tableName);
          table = new Table(tableName, schema, bufferPath);
          this.registerToCatalog(engine, tableName, schema, table);
        }

        const currentRow = rowIndex++;
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
        try {
          await flushBatch();
          resolve(tableName);
        } catch (err) {
          reject(err);
        }
      });

      stream.on('error', reject);
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
          type = Number.isInteger(Number(trimmed)) ? DataType.INT32 : DataType.FLOAT64;
        }
      }
      schema.push({ name: key, dataType: type });
    }
    return schema;
  }

  convertRow(rowObj, schema) {
    const row = new Array(schema.length);
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
