import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { isVectorizableExpr, evalVectorized } from '../wasm-expr-eval.js';
import { Config } from '../../config.js';
import { setBit, clearBit } from '../../utils/bitmap.js';

function resolveColumnIndex(expr, columnMapping) {
  if (columnMapping) {
    const key = `${expr.tableAlias}.${expr.columnName}`.toUpperCase();
    if (columnMapping.has(key)) return columnMapping.get(key);
    const byName = `${expr.columnName}`.toUpperCase();
    if (columnMapping.has(byName)) return columnMapping.get(byName);
  }
  return expr.columnIndex;
}

function collectNullableColumns(expr, chunk, columnMapping, acc) {
  if (!expr || typeof expr !== 'object') return;
  if (expr.kind === BoundExprKind.COLUMN_REF) {
    const col = chunk.columns[resolveColumnIndex(expr, columnMapping)];
    if (col && col.hasNulls) acc.push(col);
    return;
  }
  for (const key of ['left', 'right', 'operand', 'expr']) {
    if (expr[key]) collectNullableColumns(expr[key], chunk, columnMapping, acc);
  }
}

function applyNullMask(col, expr, chunk, columnMapping) {
  const nullable = [];
  collectNullableColumns(expr, chunk, columnMapping, nullable);
  if (nullable.length === 0) return;
  const size = chunk.size;
  let hasNull = false;
  for (let i = 0; i < size; i++) {
    const row = chunk.activeRowIndex(i);
    let isNull = false;
    for (const src of nullable) {
      if (src.isNull(row)) { isNull = true; break; }
    }
    if (isNull) { clearBit(col.nullBitmap, i); hasNull = true; }
    else setBit(col.nullBitmap, i);
  }
  col.hasNulls = hasNull;
}

async function tryWasmProject(expr, chunk, columnMapping) {
  if (!isVectorizableExpr(expr)) return null;
  if (chunk.size < Config.wasmMinChunkSize) return null;

  const result = await evalVectorized(expr, chunk, columnMapping, chunk.size);
  if (result === null || typeof result === 'number') return null;

  const col = new Column('FLOAT64', chunk.size);
  col.data.set(result);
  col.length = chunk.size;
  applyNullMask(col, expr, chunk, columnMapping);
  return col;
}

export class ProjectionOperator {
  constructor(expressions, evaluators, resultTypes = null, columnMapping = null, parallelDispatch) {
    this.expressions = expressions;
    this.evaluators = evaluators;
    this.resultTypes = resultTypes;
    this.columnMapping = columnMapping;
    this.parallelDispatch = parallelDispatch || null;

    this.colRefIndices = expressions.map((expr) => {
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

      if (this.expressions[e] && !this.parallelDispatch) {
        const wasmCol = await tryWasmProject(this.expressions[e], chunk, this.columnMapping);
        if (wasmCol) {
          outputCols.push(wasmCol);
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
