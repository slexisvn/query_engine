import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class ProjectionOperator {
  constructor(expressions, evaluators, resultTypes = null, columnMapping = null) {
    this.expressions = expressions;
    this.evaluators = evaluators;
    this.resultTypes = resultTypes;
    this.columnMapping = columnMapping;

    this.colRefIndices = expressions.map((expr, i) => {
      if (expr?.kind === BoundExprKind.COLUMN_REF) {
        return this._resolveColIdx(expr);
      }
      return -1;
    });
  }

  async init() {}

  async process(chunk) {
    if (chunk.size === 0) return new DataChunk([], 0);

    const outputCols = [];
    const needsFlatten = !!chunk.selectionVector;

    for (let e = 0; e < this.evaluators.length; e++) {
      const colRefIdx = this.colRefIndices[e];
      const dataType = this.resultTypes ? this.resultTypes[e] : (this.expressions[e]?.dataType || this.expressions[e]?.resultType || 'VARCHAR');

      if (colRefIdx >= 0 && !needsFlatten) {
        const srcCol = chunk.columns[colRefIdx];
        if (srcCol) {
          outputCols.push(srcCol);
          continue;
        }
      }

      const evalFn = this.evaluators[e];
      const col = new Column(dataType, chunk.size || 1);

      for (let i = 0; i < chunk.size; i++) {
        const rowIdx = chunk.activeRowIndex(i);
        const val = evalFn(chunk, rowIdx);
        col.set(i, typeof val === 'bigint' && dataType !== 'INT64' ? Number(val) : val);
      }
      col.length = chunk.size;
      outputCols.push(col);
    }

    return new DataChunk(outputCols, chunk.size);
  }

  _resolveColIdx(expr) {
    if (this.columnMapping) {
      const key = `${expr.tableAlias}.${expr.columnName}`.toUpperCase();
      if (this.columnMapping.has(key)) return this.columnMapping.get(key);
      const byName = expr.columnName.toUpperCase();
      if (this.columnMapping.has(byName)) return this.columnMapping.get(byName);
    }
    return expr.columnIndex >= 0 ? expr.columnIndex : -1;
  }
}
