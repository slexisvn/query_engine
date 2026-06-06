import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { JoinType } from '../../planner/logical-plan.js';

export class NestedLoopJoinOperator {
  constructor(outerChunks, innerChunks, outerColCount, innerColCount, joinType = JoinType.INNER, conditionEvaluator = null) {
    this.outerChunks = outerChunks;
    this.innerChunks = innerChunks;
    this.outerColCount = outerColCount;
    this.innerColCount = innerColCount;
    this.joinType = joinType;
    this.conditionEvaluator = conditionEvaluator;
  }

  async execute() {
    const outerRows = this._flattenChunks(this.outerChunks);
    const innerRows = this._flattenChunks(this.innerChunks);
    const outputRows = [];
    const adapter = this.conditionEvaluator ? this._createAdapter() : null;
    const innerMatched = (this.joinType === JoinType.FULL || this.joinType === JoinType.RIGHT)
      ? new Uint8Array(innerRows.length)
      : null;

    for (let o = 0; o < outerRows.length; o++) {
      const oRow = outerRows[o];
      let matched = false;

      for (let i = 0; i < innerRows.length; i++) {
        const iRow = innerRows[i];
        const combined = this._combineRow(oRow, iRow);

        if (adapter) {
          adapter.setRow(combined);
          if (!this.conditionEvaluator(adapter, 0)) continue;
        }

        matched = true;
        if (innerMatched) innerMatched[i] = 1;

        if (this.joinType === JoinType.SEMI) {
          outputRows.push(this._extractOuter(oRow));
          break;
        }

        if (this.joinType === JoinType.ANTI) break;

        if (this.joinType === JoinType.MARK) break;

        outputRows.push(combined);
      }

      if (!matched) {
        if (this.joinType === JoinType.LEFT || this.joinType === JoinType.FULL) {
          outputRows.push(this._outerWithNulls(oRow));
        } else if (this.joinType === JoinType.ANTI) {
          outputRows.push(this._extractOuter(oRow));
        } else if (this.joinType === JoinType.MARK) {
          outputRows.push(this._outerWithMark(oRow, false));
        }
      } else if (this.joinType === JoinType.MARK) {
        outputRows.push(this._outerWithMark(oRow, true));
      }
    }

    if (innerMatched) {
      for (let i = 0; i < innerRows.length; i++) {
        if (!innerMatched[i]) {
          outputRows.push(this._innerWithNulls(innerRows[i]));
        }
      }
    }

    if (outputRows.length === 0) return [];
    return [this._buildOutputChunk(outputRows)];
  }

  _flattenChunks(chunks) {
    const rows = [];
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.size; i++) {
        const idx = chunk.activeRowIndex(i);
        const row = new Array(chunk.columns.length);
        for (let c = 0; c < chunk.columns.length; c++) {
          row[c] = chunk.columns[c].get(idx);
        }
        rows.push(row);
      }
    }
    return rows;
  }

  _combineRow(outerRow, innerRow) {
    const row = new Array(this.outerColCount + this.innerColCount);
    for (let c = 0; c < this.outerColCount; c++) row[c] = outerRow[c];
    for (let c = 0; c < this.innerColCount; c++) row[this.outerColCount + c] = innerRow[c];
    return row;
  }

  _extractOuter(outerRow) {
    return outerRow.slice(0, this.outerColCount);
  }

  _outerWithNulls(outerRow) {
    const row = new Array(this.outerColCount + this.innerColCount);
    for (let c = 0; c < this.outerColCount; c++) row[c] = outerRow[c];
    for (let c = 0; c < this.innerColCount; c++) row[this.outerColCount + c] = null;
    return row;
  }

  _innerWithNulls(innerRow) {
    const row = new Array(this.outerColCount + this.innerColCount);
    for (let c = 0; c < this.outerColCount; c++) row[c] = null;
    for (let c = 0; c < this.innerColCount; c++) row[this.outerColCount + c] = innerRow[c];
    return row;
  }

  _outerWithMark(outerRow, markValue) {
    const row = new Array(this.outerColCount + 1);
    for (let c = 0; c < this.outerColCount; c++) row[c] = outerRow[c];
    row[this.outerColCount] = markValue;
    return row;
  }

  _buildOutputChunk(rows) {
    const colCount = rows[0].length;
    const columns = new Array(colCount);

    for (let c = 0; c < colCount; c++) {
      let dt = 'VARCHAR';
      if (this.joinType === JoinType.MARK && c === colCount - 1) {
        dt = 'BOOLEAN';
      } else if (this.joinType === JoinType.SEMI || this.joinType === JoinType.ANTI) {
        if (c < this.outerColCount && this.outerChunks.length > 0 && this.outerChunks[0].columns[c]) {
          dt = this.outerChunks[0].columns[c].dataType;
        }
      } else {
        if (c < this.outerColCount && this.outerChunks.length > 0 && this.outerChunks[0].columns[c]) {
          dt = this.outerChunks[0].columns[c].dataType;
        } else if (c >= this.outerColCount && this.innerChunks.length > 0) {
          const innerIdx = c - this.outerColCount;
          if (this.innerChunks[0].columns[innerIdx]) {
            dt = this.innerChunks[0].columns[innerIdx].dataType;
          }
        }
      }

      const col = new Column(dt, rows.length);
      for (let r = 0; r < rows.length; r++) {
        col.set(r, rows[r][c]);
      }
      col.length = rows.length;
      columns[c] = col;
    }

    return new DataChunk(columns, rows.length);
  }

  _createAdapter() {
    const totalCols = this.outerColCount + this.innerColCount;
    const columns = new Array(totalCols);
    const adapter = {
      row: null,
      columns,
      setRow(r) { this.row = r; },
    };
    for (let c = 0; c < totalCols; c++) {
      columns[c] = { get: () => adapter.row[c] };
    }
    return adapter;
  }
}
