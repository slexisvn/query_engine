import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { isVectorizableExpr, evalVectorized } from '../wasm-expr-eval.js';
import { Config } from '../../config.js';
import { isFixedWidth } from '../../storage/data-type.js';

const ARITH_OP_MAP = { '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div' };
const ARITH_OPS = new Set(['+', '-', '*', '/']);

async function tryWasmProject(expr, chunk, columnMapping) {
  if (!isVectorizableExpr(expr)) return null;
  if (chunk.size < Config.wasmMinChunkSize) return null;

  const result = await evalVectorized(expr, chunk, columnMapping, chunk.size);
  if (result === null || typeof result === 'number') return null;

  const col = new Column('FLOAT64', chunk.size);
  col.data.set(result);
  col.length = chunk.size;
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

      if (this.parallelDispatch && this.expressions[e] && !needsFlatten) {
        const parallelCol = await this._tryParallelProject(this.expressions[e], chunk);
        if (parallelCol) {
          outputCols.push(parallelCol);
          continue;
        }
      }

      if (this.expressions[e]) {
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

  async _tryParallelProject(expr, chunk) {
    const plan = this._analyzeProjectExpr(expr, chunk);
    if (!plan) return null;

    let result;
    if (plan.kind === 'scalar') {
      const colData = this._getColData(chunk, plan.colExpr);
      if (!colData) return null;
      result = await this.parallelDispatch.projectParallel(
        colData, chunk.size, plan.op, { scalar: plan.scalar }
      );
    } else if (plan.kind === 'vec') {
      const dataA = this._getColData(chunk, plan.colExprA);
      const dataB = this._getColData(chunk, plan.colExprB);
      if (!dataA || !dataB) return null;
      result = await this.parallelDispatch.projectParallel(
        dataA, chunk.size, plan.op, { dataB }
      );
    } else if (plan.kind === 'unary') {
      const colData = this._getColData(chunk, plan.colExpr);
      if (!colData) return null;
      result = await this.parallelDispatch.projectParallel(
        colData, chunk.size, plan.op, {}
      );
    }

    if (!result) return null;

    const col = new Column('FLOAT64', chunk.size);
    col.data.set(result);
    col.length = chunk.size;
    return col;
  }

  _analyzeProjectExpr(expr, chunk) {
    if (!expr || !isVectorizableExpr(expr)) return null;
    if (chunk.size < Config.parallelThreshold) return null;

    if (expr.kind === BoundExprKind.BINARY && ARITH_OPS.has(expr.op)) {
      const leftIsCol = expr.left?.kind === BoundExprKind.COLUMN_REF;
      const rightIsCol = expr.right?.kind === BoundExprKind.COLUMN_REF;
      const leftIsLit = expr.left?.kind === BoundExprKind.LITERAL;
      const rightIsLit = expr.right?.kind === BoundExprKind.LITERAL;

      if (leftIsCol && rightIsLit) {
        if (!isFixedWidth(expr.left.dataType)) return null;
        return { kind: 'scalar', op: `scalar${ARITH_OP_MAP[expr.op]}F64`, colExpr: expr.left, scalar: Number(expr.right.value) };
      }
      if (rightIsCol && leftIsLit) {
        if (!isFixedWidth(expr.right.dataType)) return null;
        if (expr.op === '+' || expr.op === '*') {
          return { kind: 'scalar', op: `scalar${ARITH_OP_MAP[expr.op]}F64`, colExpr: expr.right, scalar: Number(expr.left.value) };
        }
        if (expr.op === '-') return { kind: 'scalar', op: 'scalarSubRevF64', colExpr: expr.right, scalar: Number(expr.left.value) };
        if (expr.op === '/') return { kind: 'scalar', op: 'scalarDivRevF64', colExpr: expr.right, scalar: Number(expr.left.value) };
      }
      if (leftIsCol && rightIsCol) {
        if (!isFixedWidth(expr.left.dataType) || !isFixedWidth(expr.right.dataType)) return null;
        return { kind: 'vec', op: `vec${ARITH_OP_MAP[expr.op]}F64`, colExprA: expr.left, colExprB: expr.right };
      }
    }

    if (expr.kind === BoundExprKind.UNARY && expr.op === '-' && expr.operand?.kind === BoundExprKind.COLUMN_REF) {
      if (!isFixedWidth(expr.operand.dataType)) return null;
      return { kind: 'unary', op: 'negF64', colExpr: expr.operand };
    }

    return null;
  }

  _getColData(chunk, colExpr) {
    const idx = this._resolveColIdx(colExpr);
    if (idx < 0) return null;
    const col = chunk.columns[idx];
    if (!col?.data) return null;
    if (col.dataType === 'FLOAT64') return col.data.subarray(0, chunk.size);
    if (col.dataType === 'INT32' || col.dataType === 'DATE') return col.data.subarray(0, chunk.size);
    return null;
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
