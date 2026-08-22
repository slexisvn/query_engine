import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';
import type { ColumnValue } from '../../storage/data-type.js';
import type { ExecColumn, ExecSchema } from '../execution-types.js';
import { materializeActiveRow } from './join-core.js';
import { SCALAR_OUTPUT_NAME, SubqueryType } from '../../planner/logical-plan.js';

type JoinRow = ColumnValue[];

type SubqueryEmitter = (outerRow: JoinRow, subRows: JoinRow[]) => JoinRow | null;

const EMITTERS: Partial<Record<SubqueryType, SubqueryEmitter>> = {
  [SubqueryType.EXISTS]: (outerRow, subRows) => (subRows.length > 0 ? outerRow : null),
  [SubqueryType.NOT_EXISTS]: (outerRow, subRows) => (subRows.length === 0 ? outerRow : null),
  [SubqueryType.SCALAR]: (outerRow, subRows) => [...outerRow, subRows.length > 0 ? subRows[0][0] : null],
};

export class DependentJoinOperator {
  subqueryType: SubqueryType;
  outerSchema: ExecSchema;
  resultRows: JoinRow[];
  resultSchema: ExecSchema;
  emit: SubqueryEmitter;

  constructor(subqueryType: SubqueryType, outerSchema: ExecSchema, scalarColumn: string | null = null) {
    const emit = EMITTERS[subqueryType];
    if (!emit) {
      throw new Error(`Dependent join cannot evaluate a ${subqueryType} subquery: it compares no outer expression`);
    }
    this.subqueryType = subqueryType;
    this.outerSchema = outerSchema;
    this.resultRows = [];
    this.emit = emit;
    this.resultSchema = this.subqueryType === SubqueryType.SCALAR
      ? [...outerSchema, { name: scalarColumn ?? SCALAR_OUTPUT_NAME, dataType: DataType.FLOAT64, tableAlias: '' } as ExecColumn]
      : outerSchema;
  }

  async processOuterRow(outerRow: JoinRow, subResultChunks: DataChunk[]): Promise<void> {
    const subRows: JoinRow[] = [];
    for (const chunk of subResultChunks) {
      for (let i = 0; i < chunk.size; i++) {
        subRows.push(materializeActiveRow(chunk, i));
      }
    }

    const row = this.emit(outerRow, subRows);
    if (row) this.resultRows.push(row);
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
