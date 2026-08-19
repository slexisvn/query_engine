import { Column } from '../../storage/column.js';
import { DataType } from '../../storage/data-type.js';
import type { ColumnValue } from '../../storage/data-type.js';
import { DataChunk, AnyColumn } from '../../storage/chunk.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr, BoundColumnRefNode } from '../../binder/expression-binder.js';
import { isVectorizableExpr, evalVectorized } from '../wasm-expr-eval.js';
import { Config } from '../../config.js';
import { setBit, clearBit } from '../../utils/bitmap.js';
import type { CompiledExpr, ColumnMapping } from '../execution-types.js';
import { resolveColumnIndex } from '../column-resolve.js';
import { compileColumnarProjection, type ColumnarProjection } from '../columnar-projection.js';

interface ParallelDispatchLike {
  canParallelize(op: string, dt: DataType, n: number): boolean;
}

function collectNullableColumns(expr: BoundExpr | null, chunk: DataChunk, columnMapping: ColumnMapping | null, acc: AnyColumn[]): void {
  if (!expr || typeof expr !== 'object') return;
  if (expr.kind === BoundExprKind.COLUMN_REF) {
    const col = chunk.columns[resolveColumnIndex(expr, columnMapping)];
    if (col && col.hasNulls) acc.push(col);
    return;
  }
  const node = expr as { left?: BoundExpr; right?: BoundExpr; operand?: BoundExpr; expr?: BoundExpr };
  for (const key of ['left', 'right', 'operand', 'expr'] as const) {
    const child = node[key];
    if (child) collectNullableColumns(child, chunk, columnMapping, acc);
  }
}

function applyNullMask(col: Column, expr: BoundExpr, chunk: DataChunk, columnMapping: ColumnMapping | null): void {
  const nullable: AnyColumn[] = [];
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

async function tryWasmProject(expr: BoundExpr, chunk: DataChunk, columnMapping: ColumnMapping | null): Promise<Column | null> {
  if (!isVectorizableExpr(expr)) return null;
  if (chunk.size < Config.wasmMinChunkSize) return null;

  const result = await evalVectorized(expr, chunk, columnMapping, chunk.size);
  if (result === null || typeof result === 'number') return null;

  const col = new Column(DataType.FLOAT64, chunk.size);
  (col.data! as Float64Array).set(result);
  col.length = chunk.size;
  applyNullMask(col, expr, chunk, columnMapping);
  return col;
}

export class ProjectionOperator {
  expressions: BoundExpr[];
  evaluators: CompiledExpr[];
  resultTypes: DataType[] | null;
  columnMapping: ColumnMapping | null;
  parallelDispatch: ParallelDispatchLike | null;
  colRefIndices: number[];
  columnarProjections: (ColumnarProjection | null)[];

  constructor(expressions: BoundExpr[], evaluators: CompiledExpr[], resultTypes: DataType[] | null = null, columnMapping: ColumnMapping | null = null, parallelDispatch: ParallelDispatchLike | null) {
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

    this.columnarProjections = expressions.map((expr) => compileColumnarProjection(expr, columnMapping));
  }

  async init(): Promise<void> {}

  async process(chunk: DataChunk): Promise<DataChunk> {
    if (chunk.size === 0) return new DataChunk([], 0);

    const outputCols: AnyColumn[] = [];
    const needsFlatten = !!chunk.selectionVector;

    for (let e = 0; e < this.evaluators.length; e++) {
      const colRefIdx = this.colRefIndices[e];
      const expr = this.expressions[e] as (BoundExpr & { dataType?: string; resultType?: string }) | undefined;
      const dataType = (this.resultTypes ? this.resultTypes[e] : (expr?.dataType || expr?.resultType || 'VARCHAR')) as DataType;

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

      const columnar = this.columnarProjections[e];
      if (columnar && dataType === DataType.FLOAT64) {
        const vectorCol = columnar(chunk);
        if (vectorCol) {
          outputCols.push(vectorCol);
          continue;
        }
      }

      const evalFn = this.evaluators[e];
      const col = new Column(dataType, chunk.size || 1);

      for (let i = 0; i < chunk.size; i++) {
        const rowIdx = chunk.activeRowIndex(i);
        const val = evalFn(chunk, rowIdx);
        col.set(i, typeof val === 'bigint' && dataType !== DataType.INT64 ? Number(val) : (val as ColumnValue));
      }
      col.length = chunk.size;
      outputCols.push(col);
    }

    return new DataChunk(outputCols, chunk.size);
  }

  _resolveColIdx(expr: BoundColumnRefNode): number {
    return resolveColumnIndex(expr, this.columnMapping, { clampNegative: true });
  }
}
