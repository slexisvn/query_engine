import { BoundExprKind } from '../binder/expression-binder.js';
import type { BoundExpr, BoundColumnRefNode } from '../binder/expression-binder.js';
import { globalDispatch } from '../wasm/dispatch.js';
import { Config } from '../config.js';
import type { DataChunk } from '../storage/chunk.js';
import type { Column } from '../storage/column.js';
import type { ColumnMapping } from './execution-types.js';
import { resolveColumnIndex } from './column-resolve.js';

const NUMERIC_TYPES = new Set(['INT32', 'FLOAT64', 'DATE', 'DECIMAL']);
const WIDEN_TYPES = new Set(['INT32', 'DATE']);
const ARITH_OPS = new Set(['+', '-', '*', '/']);
const DECIMAL_SCALE = 100;

type VecData = Float64Array | Int32Array;
type Kernel = (a: VecData | number, b?: VecData | number) => VecData | Promise<VecData>;

interface WasmDispatchModule {
  kernels: Map<string, Kernel>;
  lookup(operation: string, dataType: string): Kernel | null;
}

const dispatch: WasmDispatchModule = globalDispatch;

export function isVectorizableExpr(expr: BoundExpr | null): boolean {
  if (!expr) return false;
  if (expr.kind === BoundExprKind.COLUMN_REF) return NUMERIC_TYPES.has(expr.dataType as string);
  if (expr.kind === BoundExprKind.LITERAL) return typeof expr.value === 'number';
  if (expr.kind === BoundExprKind.BINARY && ARITH_OPS.has(expr.op)) {
    return isVectorizableExpr(expr.left) && isVectorizableExpr(expr.right);
  }
  if (expr.kind === BoundExprKind.UNARY && expr.op === '-') {
    return isVectorizableExpr(expr.operand);
  }
  return false;
}

function extractColumnF64(col: Column, chunk: DataChunk, size: number): VecData | null {
  const sv = chunk.selectionVector;
  const data = col.data!;
  if (col.dataType === 'DECIMAL') {
    const f64 = new Float64Array(size);
    if (sv) {
      for (let i = 0; i < size; i++) f64[i] = Number(data[sv[i]]) / DECIMAL_SCALE;
    } else {
      for (let i = 0; i < size; i++) f64[i] = Number(data[i]) / DECIMAL_SCALE;
    }
    return f64;
  }
  if (WIDEN_TYPES.has(col.dataType)) {
    if (sv) {
      const compact = new Int32Array(size);
      for (let i = 0; i < size; i++) compact[i] = data[sv[i]] as number;
      return compact;
    }
    return (data as Int32Array).subarray(0, size);
  }
  if (col.dataType === 'FLOAT64') {
    if (sv) {
      const compact = new Float64Array(size);
      for (let i = 0; i < size; i++) compact[i] = data[sv[i]] as number;
      return compact;
    }
    return (data as Float64Array).subarray(0, size);
  }
  return null;
}

export async function evalVectorized(expr: BoundExpr, chunk: DataChunk, columnMapping: ColumnMapping | null, size: number): Promise<VecData | number | null> {
  if (dispatch.kernels.size === 0) return null;

  if (expr.kind === BoundExprKind.COLUMN_REF) {
    const idx = resolveColIndex(expr, columnMapping);
    if (idx < 0) return null;
    const col = chunk.columns[idx] as Column;
    if (!col || !col.data) return null;
    const raw = extractColumnF64(col, chunk, size);
    if (!raw) return null;
    if (raw instanceof Int32Array) {
      const kernel = dispatch.lookup('widenI32ToF64', 'INT32');
      return kernel ? await kernel(raw) : null;
    }
    return raw;
  }

  if (expr.kind === BoundExprKind.LITERAL) {
    return Number(expr.value);
  }

  if (expr.kind === BoundExprKind.UNARY && expr.op === '-') {
    const operand = await evalVectorized(expr.operand, chunk, columnMapping, size);
    if (operand === null) return null;
    if (typeof operand === 'number') return -operand;
    const kernel = dispatch.lookup('negF64', 'FLOAT64');
    if (!kernel) return null;
    return await kernel(operand);
  }

  if (expr.kind === BoundExprKind.BINARY && ARITH_OPS.has(expr.op)) {
    const left = await evalVectorized(expr.left, chunk, columnMapping, size);
    if (left === null) return null;
    const right = await evalVectorized(expr.right, chunk, columnMapping, size);
    if (right === null) return null;

    const leftIsArr = left instanceof Float64Array || left instanceof Int32Array;
    const rightIsArr = right instanceof Float64Array || right instanceof Int32Array;

    if (leftIsArr && rightIsArr) {
      const name = ({ '+': 'vecAddF64', '-': 'vecSubF64', '*': 'vecMulF64', '/': 'vecDivF64' } as Record<string, string>)[expr.op];
      const kernel = dispatch.lookup(name, 'FLOAT64');
      return kernel ? await kernel(left, right) : null;
    }

    if (leftIsArr && !rightIsArr) {
      const name = ({ '+': 'scalarAddF64', '-': 'scalarSubF64', '*': 'scalarMulF64', '/': 'scalarDivF64' } as Record<string, string>)[expr.op];
      const kernel = dispatch.lookup(name, 'FLOAT64');
      return kernel ? await kernel(left, Number(right)) : null;
    }

    if (!leftIsArr && rightIsArr) {
      if (expr.op === '+' || expr.op === '*') {
        const name = expr.op === '+' ? 'scalarAddF64' : 'scalarMulF64';
        const kernel = dispatch.lookup(name, 'FLOAT64');
        return kernel ? await kernel(right, Number(left)) : null;
      }
      if (expr.op === '-') {
        const kernel = dispatch.lookup('scalarSubRevF64', 'FLOAT64');
        return kernel ? await kernel(Number(left), right) : null;
      }
      if (expr.op === '/') {
        const kernel = dispatch.lookup('scalarDivRevF64', 'FLOAT64');
        return kernel ? await kernel(Number(left), right) : null;
      }
    }
  }

  return null;
}

function resolveColIndex(expr: BoundColumnRefNode, columnMapping: ColumnMapping | null): number {
  return resolveColumnIndex(expr, columnMapping, { clampNegative: true });
}
