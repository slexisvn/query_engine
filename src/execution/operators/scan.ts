import type { DataChunk } from '../../storage/chunk.js';
import type { ChunkPruner } from '../../storage/zone-map.js';
import type { ExecSchema } from '../execution-types.js';

interface TableStorageLike {
  getSchema(): ExecSchema;
  scan(pruner?: ChunkPruner | null): AsyncGenerator<DataChunk>;
  scanAll(): Promise<DataChunk[]>;
  rowCount(): number;
}

export class ScanOperator {
  table: TableStorageLike;
  projectedColumns: number[] | null;
  pruner: ChunkPruner | null;

  constructor(table: TableStorageLike, projectedColumns: number[] | null, pruner: ChunkPruner | null = null) {
    this.table = table;
    this.projectedColumns = projectedColumns || null;
    this.pruner = pruner;
  }

  async init(): Promise<void> {}

  async *scan(): AsyncGenerator<DataChunk> {
    for await (const chunk of this.table.scan(this.pruner)) {
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
