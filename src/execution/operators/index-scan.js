import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { Config } from '../../config.js';

export class IndexScanOperator {
  constructor(btreeIndex, table, scanType, scanKey, scanLow, scanHigh, lowInc, highInc, projectedColumns) {
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

  async *scan() {
    let locations;
    if (this.scanType === 'point') {
      locations = this.btreeIndex.search(this.scanKey);
    } else {
      locations = [...this.btreeIndex.range(this.scanLow, this.scanHigh, this.lowInc, this.highInc)];
    }

    if (locations.length === 0) return;

    const pageGroups = new Map();
    for (const loc of locations) {
      let group = pageGroups.get(loc.pageId);
      if (!group) { group = []; pageGroups.set(loc.pageId, group); }
      group.push(loc.rowIndex);
    }

    const schema = this.table.getSchema();
    const outputSchema = this.projectedColumns
      ? this.projectedColumns.map(i => schema[i])
      : schema;

    let pendingRows = [];

    for (const [pageId, rowIndices] of pageGroups) {
      const page = await this.table.bufferPool.fetchPage(pageId, true);

      for (const rowIdx of rowIndices) {
        const row = [];
        if (this.projectedColumns) {
          for (const colIdx of this.projectedColumns) {
            row.push(page.columns[colIdx].get(rowIdx));
          }
        } else {
          for (let c = 0; c < page.columns.length; c++) {
            row.push(page.columns[c].get(rowIdx));
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

  _buildChunk(rows, schema) {
    const colCount = schema.length;
    const columns = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const col = new Column(schema[c].dataType, rows.length);
      for (let r = 0; r < rows.length; r++) {
        col.set(r, rows[r][c]);
      }
      col.length = rows.length;
      columns[c] = col;
    }
    return new DataChunk(columns, rows.length);
  }
}
