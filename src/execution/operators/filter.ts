import type { ParallelExpressionDispatch } from '../parallel-context.js';
import { DataChunk, AnyColumn, SelectionVector } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr, BoundColumnRefNode } from '../../binder/expression-binder.js';
import { isFixedWidth } from '../../storage/data-type.js';
import type { AnyTypedArray, ColumnValue, DataType } from '../../storage/data-type.js';
import type { CompiledExpr, ColumnMapping } from '../execution-types.js';

const OP_TO_FILTER: Record<string, string> = {
  '=': 'filterEq',
  '<': 'filterLt',
  '>': 'filterGt',
  '<=': 'filterLe',
  '>=': 'filterGe',
};

interface SimpleFilterPlan {
  type: 'simple';
  operation: string;
  dataType: DataType;
  columnIndex: number;
  value: ColumnValue;
}

interface BetweenFilterPlan {
  type: 'between';
  operation: string;
  dataType: DataType;
  columnIndex: number;
  low: ColumnValue;
  high: ColumnValue;
}

interface AndFilterPlan {
  type: 'and';
  left: FilterPlan;
  right: FilterPlan;
}

interface OrFilterPlan {
  type: 'or';
  left: FilterPlan;
  right: FilterPlan;
}

type FilterPlan = SimpleFilterPlan | BetweenFilterPlan | AndFilterPlan | OrFilterPlan;

export class FilterOperator {
  predicate: BoundExpr | null;
  evaluator: CompiledExpr;
  columnMapping: ColumnMapping | null;
  parallelDispatch: ParallelExpressionDispatch | null;

  constructor(predicate: BoundExpr | null, evaluator: CompiledExpr, columnMapping: ColumnMapping | null, parallelDispatch: ParallelExpressionDispatch | null) {
    this.predicate = predicate;
    this.evaluator = evaluator;
    this.columnMapping = columnMapping || null;
    this.parallelDispatch = parallelDispatch || null;
  }

  async init(): Promise<void> {}

  async process(chunk: DataChunk): Promise<DataChunk> {
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

  _analyze(expr: BoundExpr | null): FilterPlan | null {
    if (!expr) return null;

    if (expr.kind === BoundExprKind.BINARY) {
      const logical = this._analyzeLogical(expr);
      if (logical) return logical;
      return this._analyzeComparison(expr);
    }

    if (expr.kind === BoundExprKind.BETWEEN) {
      return this._analyzeBetween(expr);
    }

    return null;
  }

  _analyzeComparison(expr: BoundExpr): FilterPlan | null {
    const op = (expr as { op: string }).op;
    if (!OP_TO_FILTER[op]) return null;

    const { columnRef, literal } = this._extractColumnAndLiteral(expr);
    if (!columnRef || literal === null) return null;

    const dataType = columnRef.dataType as DataType;
    if (!isFixedWidth(dataType)) return null;

    const operation = OP_TO_FILTER[op];
    if (!this.parallelDispatch!.canParallelize(operation, dataType, 1)) return null;

    return {
      type: 'simple',
      operation,
      dataType,
      columnIndex: columnRef.columnIndex,
      value: literal,
    };
  }

  _analyzeBetween(expr: BoundExpr): FilterPlan | null {
    const between = expr as { expr: BoundExpr | null; low: BoundExpr; high: BoundExpr };
    if (!between.expr || between.expr.kind !== BoundExprKind.COLUMN_REF) return null;

    const colRef = between.expr as BoundColumnRefNode;
    if (!isFixedWidth(colRef.dataType as DataType)) return null;

    const low = this._extractLiteralValue(between.low);
    const high = this._extractLiteralValue(between.high);
    if (low === null || high === null) return null;

    return {
      type: 'between',
      operation: 'filterBetween',
      dataType: colRef.dataType as DataType,
      columnIndex: colRef.columnIndex,
      low,
      high,
    };
  }

  _analyzeLogical(expr: BoundExpr): FilterPlan | null {
    const op = (expr as { op: string }).op;
    if (op !== 'AND' && op !== 'OR') return null;

    const binary = expr as { left: BoundExpr; right: BoundExpr };
    const leftPlan = this._analyze(binary.left);
    const rightPlan = this._analyze(binary.right);

    if (!leftPlan || !rightPlan) return null;

    return {
      type: op === 'AND' ? 'and' : 'or',
      left: leftPlan,
      right: rightPlan,
    };
  }

  _extractColumnAndLiteral(expr: BoundExpr): { columnRef: BoundColumnRefNode | null; literal: ColumnValue } {
    let columnRef: BoundColumnRefNode | null = null;
    let literal: ColumnValue = null;

    const binary = expr as { left?: BoundExpr; right?: BoundExpr };
    if (binary.left?.kind === BoundExprKind.COLUMN_REF && binary.right?.kind === BoundExprKind.LITERAL) {
      columnRef = binary.left;
      literal = binary.right.value;
    } else if (binary.right?.kind === BoundExprKind.COLUMN_REF && binary.left?.kind === BoundExprKind.LITERAL) {
      columnRef = binary.right;
      literal = binary.left.value;
    }

    return { columnRef, literal };
  }

  _extractLiteralValue(expr: BoundExpr | null): ColumnValue {
    if (!expr || expr.kind !== BoundExprKind.LITERAL) return null;
    return expr.value;
  }

  async _executeParallel(chunk: DataChunk, plan: FilterPlan): Promise<DataChunk | null> {
    if (plan.type === 'simple') return this._executeSimple(chunk, plan);
    if (plan.type === 'between') return this._executeBetween(chunk, plan);
    if (plan.type === 'and') return this._executeAnd(chunk, plan);
    if (plan.type === 'or') return this._executeOr(chunk, plan);
    return null;
  }

  async _executeSimple(chunk: DataChunk, plan: SimpleFilterPlan): Promise<DataChunk | null> {
    const column = chunk.columns[plan.columnIndex];
    const data = this._getColumnData(chunk, column);
    if (!data) return null;

    const result = await this.parallelDispatch!.filterParallel(
      data, data.length, plan.operation, plan.dataType, { value: plan.value }
    );

    if (!result?.selectionVector) return null;
    const count = this._dropNullRows(column, result.selectionVector, result.matchCount);
    return this._applySelectionVector(chunk, result.selectionVector, count);
  }

  _dropNullRows(column: AnyColumn, sv: Uint32Array, count: number): number {
    if (!column.hasNulls) return count;
    let w = 0;
    for (let i = 0; i < count; i++) {
      if (!column.isNull(sv[i])) sv[w++] = sv[i];
    }
    return w;
  }

  async _executeBetween(chunk: DataChunk, plan: BetweenFilterPlan): Promise<DataChunk | null> {
    const column = chunk.columns[plan.columnIndex];
    const data = this._getColumnData(chunk, column);
    if (!data) return null;

    const result = await this.parallelDispatch!.filterParallel(
      data, data.length, plan.operation, plan.dataType, { low: plan.low, high: plan.high }
    );

    if (!result?.selectionVector) return null;
    const count = this._dropNullRows(column, result.selectionVector, result.matchCount);
    return this._applySelectionVector(chunk, result.selectionVector, count);
  }

  async _executeAnd(chunk: DataChunk, plan: AndFilterPlan): Promise<DataChunk | null> {
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

  async _executeOr(chunk: DataChunk, plan: OrFilterPlan): Promise<DataChunk | null> {
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

  _getColumnData(chunk: DataChunk, column: AnyColumn): AnyTypedArray | null {
    if (chunk.selectionVector) return null;
    const data = (column as Column).data;
    if (!data) return null;
    return data.subarray(0, column.length);
  }

  _applySelectionVector(chunk: DataChunk, sv: SelectionVector, count: number): DataChunk {
    if (count === 0) return new DataChunk(chunk.columns, 0);
    if (count === chunk.size && !chunk.selectionVector) return chunk;

    const result = new DataChunk(chunk.columns, count);
    result.setSelectionVector(sv.length === count ? sv : (sv as Uint32Array).subarray(0, count), count);
    return result;
  }

  _executeFallback(chunk: DataChunk): DataChunk {
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

export function intersectSorted(a: SelectionVector, aLen: number, b: SelectionVector, bLen: number): { data: Uint32Array; count: number } {
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

export function unionSorted(a: SelectionVector, aLen: number, b: SelectionVector, bLen: number): { data: Uint32Array; count: number } {
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
