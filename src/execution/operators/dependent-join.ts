import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';
import type { ColumnValue } from '../../storage/data-type.js';
import type { ExecColumn, ExecSchema } from '../execution-types.js';

type JoinRow = ColumnValue[];

export class DependentJoinOperator {
  subqueryType: string;
  outerSchema: ExecSchema;
  resultRows: JoinRow[];
  resultSchema: ExecSchema;

  constructor(subqueryType: string, outerSchema: ExecSchema) {
    this.subqueryType = subqueryType;
    this.outerSchema = outerSchema;
    this.resultRows = [];
    this.resultSchema = this.subqueryType === 'SCALAR'
      ? [...outerSchema, { name: '_scalar', dataType: DataType.FLOAT64, tableAlias: '' } as ExecColumn]
      : outerSchema;
  }

  async processOuterRow(outerRow: JoinRow, subResultChunks: DataChunk[]): Promise<void> {
    const subRows: JoinRow[] = [];
    for (const chunk of subResultChunks) {
      for (let i = 0; i < chunk.size; i++) {
        const row: JoinRow = [];
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

  async finalize(): Promise<DataChunk[]> {
    if (this.resultRows.length === 0) {
      return [];
    }

    const colCount = this.resultSchema.length;
    const cols: Column[] = [];
    for (let c = 0; c < colCount; c++) {
      const col = new Column((this.resultSchema[c].dataType || DataType.VARCHAR) as DataType, this.resultRows.length);
      for (let r = 0; r < this.resultRows.length; r++) {
        col.set(r, this.resultRows[r][c]);
      }
      col.length = this.resultRows.length;
      cols.push(col);
    }

    return [new DataChunk(cols, this.resultRows.length)];
  }
}
