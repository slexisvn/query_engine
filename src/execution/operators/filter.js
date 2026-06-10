import { DataChunk } from '../../storage/chunk.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { isFixedWidth } from '../../storage/data-type.js';

const OP_TO_FILTER = {
  '=': 'filterEq',
  '<': 'filterLt',
  '>': 'filterGt',
  '<=': 'filterLe',
  '>=': 'filterGe',
};

export class FilterOperator {
  constructor(predicate, evaluator, columnMapping, parallelDispatch) {
    this.predicate = predicate;
    this.evaluator = evaluator;
    this.columnMapping = columnMapping || null;
    this.parallelDispatch = parallelDispatch || null;
  }

  async init() {}

  async process(chunk) {
    const size = chunk.size;
    if (size === 0) return new DataChunk(chunk.columns, 0);

    if (this.parallelDispatch) {
      const plan = this._analyze(this.predicate);
      if (plan) {
        const result = await this._executeParallel(chunk, plan);
        if (result) return result;
      }
    }

    return this._executeFallback(chunk);
  }

  _analyze(expr) {
    if (!expr) return null;

    if (expr.kind === BoundExprKind.COMPARISON || expr.kind === BoundExprKind.BINARY) {
      const logical = this._analyzeLogical(expr);
      if (logical) return logical;
      return this._analyzeComparison(expr);
    }

    if (expr.kind === BoundExprKind.BETWEEN) {
      return this._analyzeBetween(expr);
    }

    return null;
  }

  _analyzeComparison(expr) {
    const op = expr.op;
    if (!OP_TO_FILTER[op]) return null;

    const { columnRef, literal } = this._extractColumnAndLiteral(expr);
    if (!columnRef || literal === null) return null;

    const dataType = columnRef.dataType;
    if (!isFixedWidth(dataType)) return null;

    const operation = OP_TO_FILTER[op];
    if (!this.parallelDispatch.canParallelize(operation, dataType, 1)) return null;

    return {
      type: 'simple',
      operation,
      dataType,
      columnIndex: columnRef.columnIndex,
      value: literal,
    };
  }

  _analyzeBetween(expr) {
    if (!expr.expr || expr.expr.kind !== BoundExprKind.COLUMN_REF) return null;

    const colRef = expr.expr;
    if (!isFixedWidth(colRef.dataType)) return null;

    const low = this._extractLiteralValue(expr.low);
    const high = this._extractLiteralValue(expr.high);
    if (low === null || high === null) return null;

    return {
      type: 'between',
      operation: 'filterBetween',
      dataType: colRef.dataType,
      columnIndex: colRef.columnIndex,
      low,
      high,
    };
  }

  _analyzeLogical(expr) {
    if (expr.op !== 'AND' && expr.op !== 'OR') return null;

    const leftPlan = this._analyze(expr.left);
    const rightPlan = this._analyze(expr.right);

    if (!leftPlan || !rightPlan) return null;

    return {
      type: expr.op === 'AND' ? 'and' : 'or',
      left: leftPlan,
      right: rightPlan,
    };
  }

  _extractColumnAndLiteral(expr) {
    let columnRef = null;
    let literal = null;

    if (expr.left?.kind === BoundExprKind.COLUMN_REF && expr.right?.kind === BoundExprKind.LITERAL) {
      columnRef = expr.left;
      literal = expr.right.value;
    } else if (expr.right?.kind === BoundExprKind.COLUMN_REF && expr.left?.kind === BoundExprKind.LITERAL) {
      columnRef = expr.right;
      literal = expr.left.value;
    }

    return { columnRef, literal };
  }

  _extractLiteralValue(expr) {
    if (!expr || expr.kind !== BoundExprKind.LITERAL) return null;
    return expr.value;
  }

  async _executeParallel(chunk, plan) {
    if (plan.type === 'simple') return this._executeSimple(chunk, plan);
    if (plan.type === 'between') return this._executeBetween(chunk, plan);
    if (plan.type === 'and') return this._executeAnd(chunk, plan);
    if (plan.type === 'or') return this._executeOr(chunk, plan);
    return null;
  }

  async _executeSimple(chunk, plan) {
    const column = chunk.columns[plan.columnIndex];
    const data = this._getColumnData(chunk, column);
    if (!data) return null;

    const result = await this.parallelDispatch.filterParallel(
      data, data.length, plan.operation, plan.dataType, { value: plan.value }
    );

    if (!result) return null;
    const count = this._dropNullRows(column, result.selectionVector, result.matchCount);
    return this._applySelectionVector(chunk, result.selectionVector, count);
  }

  _dropNullRows(column, sv, count) {
    if (!column.hasNulls) return count;
    let w = 0;
    for (let i = 0; i < count; i++) {
      if (!column.isNull(sv[i])) sv[w++] = sv[i];
    }
    return w;
  }

  async _executeBetween(chunk, plan) {
    const column = chunk.columns[plan.columnIndex];
    const data = this._getColumnData(chunk, column);
    if (!data) return null;

    const result = await this.parallelDispatch.filterParallel(
      data, data.length, plan.operation, plan.dataType, { low: plan.low, high: plan.high }
    );

    if (!result) return null;
    const count = this._dropNullRows(column, result.selectionVector, result.matchCount);
    return this._applySelectionVector(chunk, result.selectionVector, count);
  }

  async _executeAnd(chunk, plan) {
    const leftResult = await this._executeParallel(chunk, plan.left);
    if (!leftResult || leftResult.size === 0) return new DataChunk(chunk.columns, 0);

    const rightResult = await this._executeParallel(chunk, plan.right);
    if (!rightResult || rightResult.size === 0) return new DataChunk(chunk.columns, 0);

    const leftSv = leftResult.selectionVector;
    const rightSv = rightResult.selectionVector;

    if (!leftSv || !rightSv) return null;

    const merged = intersectSorted(leftSv, leftResult.size, rightSv, rightResult.size);
    return this._applySelectionVector(chunk, merged.data, merged.count);
  }

  async _executeOr(chunk, plan) {
    const leftResult = await this._executeParallel(chunk, plan.left);
    const rightResult = await this._executeParallel(chunk, plan.right);

    if (!leftResult && !rightResult) return null;
    if (!leftResult) return rightResult;
    if (!rightResult) return leftResult;

    const leftSv = leftResult.selectionVector;
    const rightSv = rightResult.selectionVector;

    if (!leftSv && !rightSv) return null;
    if (!leftSv) return rightResult;
    if (!rightSv) return leftResult;

    const merged = unionSorted(leftSv, leftResult.size, rightSv, rightResult.size);
    return this._applySelectionVector(chunk, merged.data, merged.count);
  }

  _getColumnData(chunk, column) {
    if (chunk.selectionVector) return null;
    if (!column.data) return null;
    return column.data.subarray(0, column.length);
  }

  _applySelectionVector(chunk, sv, count) {
    if (count === 0) return new DataChunk(chunk.columns, 0);
    if (count === chunk.size && !chunk.selectionVector) return chunk;

    const result = new DataChunk(chunk.columns, count);
    result.setSelectionVector(sv.length === count ? sv : sv.subarray(0, count), count);
    return result;
  }

  _executeFallback(chunk) {
    const size = chunk.size;
    const sv = new Uint32Array(size);
    let count = 0;

    if (chunk.selectionVector) {
      const inputSv = chunk.selectionVector;
      for (let i = 0; i < size; i++) {
        const rowIdx = inputSv[i];
        if (this.evaluator(chunk, rowIdx)) {
          sv[count++] = rowIdx;
        }
      }
    } else {
      for (let i = 0; i < size; i++) {
        if (this.evaluator(chunk, i)) {
          sv[count++] = i;
        }
      }
    }

    if (count === 0) return new DataChunk(chunk.columns, 0);
    if (count === size) return chunk;

    const result = new DataChunk(chunk.columns, count);
    if (count > 64) {
      result.setSelectionVector(sv.subarray(0, count), count);
    } else {
      result.setSelectionVector(sv.slice(0, count), count);
    }
    return result;
  }
}

export function intersectSorted(a, aLen, b, bLen) {
  const out = new Uint32Array(Math.min(aLen, bLen));
  let i = 0, j = 0, k = 0;

  while (i < aLen && j < bLen) {
    const va = a[i], vb = b[j];
    if (va === vb) {
      out[k++] = va;
      i++;
      j++;
    } else if (va < vb) {
      i++;
    } else {
      j++;
    }
  }

  return { data: out, count: k };
}

export function unionSorted(a, aLen, b, bLen) {
  const out = new Uint32Array(aLen + bLen);
  let i = 0, j = 0, k = 0;

  while (i < aLen && j < bLen) {
    const va = a[i], vb = b[j];
    if (va === vb) {
      out[k++] = va;
      i++;
      j++;
    } else if (va < vb) {
      out[k++] = va;
      i++;
    } else {
      out[k++] = vb;
      j++;
    }
  }

  while (i < aLen) out[k++] = a[i++];
  while (j < bLen) out[k++] = b[j++];

  return { data: out, count: k };
}
