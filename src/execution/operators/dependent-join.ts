import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';

export class DependentJoinOperator {
  subqueryType: any;
  outerSchema: any;
  resultRows: any[];
  resultSchema: any;

  constructor(subqueryType: any, outerSchema: any) {
    this.subqueryType = subqueryType;
    this.outerSchema = outerSchema;
    this.resultRows = [];
    this.resultSchema = this.subqueryType === 'SCALAR'
      ? [...outerSchema, { name: '_scalar', dataType: 'FLOAT64', tableAlias: '' }]
      : outerSchema;
  }

  async processOuterRow(outerRow: any, subResultChunks: any): Promise<void> {
    const subRows = [];
    for (const chunk of subResultChunks) {
      for (let i = 0; i < chunk.size; i++) {
        const row = [];
        for (let c = 0; c < chunk.columns.length; c++) {
          row.push(chunk.columns[c].get(chunk.activeRowIndex(i)));
        }
        subRows.push(row);
      }
    }

    if (this.subqueryType === 'EXISTS') {
      if (subRows.length > 0) this.resultRows.push(outerRow);
    } else if (this.subqueryType === 'NOT_EXISTS') {
      if (subRows.length === 0) this.resultRows.push(outerRow);
    } else if (this.subqueryType === 'SCALAR') {
      const scalarVal = subRows.length > 0 ? subRows[0][0] : null;
      this.resultRows.push([...outerRow, scalarVal]);
    } else if (this.subqueryType === 'IN') {
      if (subRows.length > 0) this.resultRows.push(outerRow);
    } else if (this.subqueryType === 'NOT_IN') {
      if (subRows.length === 0) this.resultRows.push(outerRow);
    } else {
      this.resultRows.push(outerRow);
    }
  }

  async finalize(): Promise<any> {
    if (this.resultRows.length === 0) {
      return [];
    }

    const colCount = this.resultSchema.length;
    const cols = [];
    for (let c = 0; c < colCount; c++) {
      const col = new Column(this.resultSchema[c].dataType || 'VARCHAR', this.resultRows.length);
      for (let r = 0; r < this.resultRows.length; r++) {
        col.set(r, this.resultRows[r][c]);
      }
      col.length = this.resultRows.length;
      cols.push(col);
    }

    return [new DataChunk(cols, this.resultRows.length)];
  }
}
