import type { DataChunk } from '../../storage/chunk.js';
import type { ExecSchema } from '../execution-types.js';

interface TableStorageLike {
  getSchema(): ExecSchema;
  scan(): AsyncGenerator<DataChunk>;
  scanAll(): Promise<DataChunk[]>;
  rowCount(): number;
}

export class ScanOperator {
  table: TableStorageLike;
  projectedColumns: number[] | null;

  constructor(table: TableStorageLike, projectedColumns: number[] | null) {
    this.table = table;
    this.projectedColumns = projectedColumns || null;
  }

  async init(): Promise<void> {}

  async *scan(): AsyncGenerator<DataChunk> {
    for await (const chunk of this.table.scan()) {
      if (this.projectedColumns) {
        yield chunk.project(this.projectedColumns);
      } else {
        yield chunk;
      }
    }
  }

  estimatedRows(): number {
    return this.table.rowCount();
  }
}
