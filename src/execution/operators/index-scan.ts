import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import type { ColumnValue, DataType } from '../../storage/data-type.js';
import { Config } from '../../config.js';
import type { ExecSchema } from '../execution-types.js';

type IndexScanKey = string | number | bigint | boolean | null | undefined;

interface RowLocationLike {
  pageId: string;
  rowIndex: number;
}

interface BTreeLike {
  search(key: IndexScanKey): RowLocationLike[];
  range(low: IndexScanKey, high: IndexScanKey, lowInclusive: boolean, highInclusive: boolean): Generator<RowLocationLike>;
}

interface BufferPoolLike {
  fetchPage(pageId: string, bypassCache: boolean): Promise<DataChunk | null>;
}

interface IndexTableLike {
  bufferPool: BufferPoolLike;
  getSchema(): ExecSchema;
}

export class IndexScanOperator {
  btreeIndex: BTreeLike;
  table: IndexTableLike;
  scanType: string;
  scanKey: IndexScanKey;
  scanLow: IndexScanKey;
  scanHigh: IndexScanKey;
  lowInc: boolean;
  highInc: boolean;
  projectedColumns: number[] | null;

  constructor(btreeIndex: BTreeLike, table: IndexTableLike, scanType: string, scanKey: IndexScanKey, scanLow: IndexScanKey, scanHigh: IndexScanKey, lowInc: boolean, highInc: boolean, projectedColumns: number[] | null) {
    this.btreeIndex = btreeIndex;
    this.table = table;
    this.scanType = scanType;
    this.scanKey = scanKey;
    this.scanLow = scanLow;
    this.scanHigh = scanHigh;
    this.lowInc = lowInc;
    this.highInc = highInc;
    this.projectedColumns = projectedColumns;
  }

  async *scan(): AsyncGenerator<DataChunk> {
    let locations: RowLocationLike[];
    if (this.scanType === 'point') {
      locations = this.btreeIndex.search(this.scanKey);
    } else {
      locations = [...this.btreeIndex.range(this.scanLow, this.scanHigh, this.lowInc, this.highInc)];
    }

    if (locations.length === 0) return;

    const pageGroups = new Map<string, number[]>();
    for (const loc of locations) {
      let group = pageGroups.get(loc.pageId);
      if (!group) { group = []; pageGroups.set(loc.pageId, group); }
      group.push(loc.rowIndex);
    }

    const schema = this.table.getSchema();
    const outputSchema = this.projectedColumns
      ? this.projectedColumns.map((i: number) => schema[i])
      : schema;

    let pendingRows: ColumnValue[][] = [];

    for (const [pageId, rowIndices] of pageGroups) {
      const page = await this.table.bufferPool.fetchPage(pageId, true);

      for (const rowIdx of rowIndices) {
        const row: ColumnValue[] = [];
        if (this.projectedColumns) {
          for (const colIdx of this.projectedColumns) {
            row.push(page!.columns[colIdx].get(rowIdx));
          }
        } else {
          for (let c = 0; c < page!.columns.length; c++) {
            row.push(page!.columns[c].get(rowIdx));
          }
        }
        pendingRows.push(row);

        if (pendingRows.length >= Config.flushBatchSize) {
          yield this._buildChunk(pendingRows, outputSchema);
          pendingRows = [];
        }
      }
    }

    if (pendingRows.length > 0) {
      yield this._buildChunk(pendingRows, outputSchema);
    }
  }

  _buildChunk(rows: ColumnValue[][], schema: ExecSchema): DataChunk {
    const colCount = schema.length;
    const columns = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const col = new Column(schema[c].dataType as DataType, rows.length);
      for (let r = 0; r < rows.length; r++) {
        col.set(r, rows[r][c]);
      }
      col.length = rows.length;
      columns[c] = col;
    }
    return new DataChunk(columns, rows.length);
  }
}
