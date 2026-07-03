
import { Column } from '../storage/column.js';
import { DataChunk } from '../storage/chunk.js';
import type { AnyColumn } from '../storage/chunk.js';
import { BoundExprKind, getExprType } from '../binder/expression-binder.js';
import type { BoundExpr } from '../binder/expression-binder.js';
import { DataType } from '../storage/data-type.js';
import type { ColumnValue } from '../storage/data-type.js';
import type { EvalValue, CompiledExpr, ColumnMapping } from './execution-types.js';
import { resolveColumnIndex as resolveColIdx } from './column-resolve.js';

interface VectorResult {
  ref?: boolean;
  colIdx?: number;
  column?: AnyColumn;
  constant?: boolean;
  value?: EvalValue;
  size?: number;
  data?: EvalValue[];
}

type VectorFn = (chunk: DataChunk) => VectorResult | null;

interface BuildRef {
  chunkIdx: number;
  rowIdx: number;
}

export function compileVectorExpression(expr: BoundExpr | null, columnMapping: ColumnMapping | null): VectorFn | null {
  if (!expr) return null;

  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF: {
      const colIdx = resolveColIdx(expr, columnMapping);
      return (chunk: DataChunk) => ({ ref: true, colIdx, column: chunk.columns[colIdx] });
    }

    case BoundExprKind.LITERAL: {
      const val = expr.value;
      return (chunk: DataChunk) => ({ ref: false, constant: true, value: val, size: chunk.size });
    }

    case BoundExprKind.BINARY: {
      const leftFn = compileVectorExpression(expr.left, columnMapping);
      const rightFn = compileVectorExpression(expr.right, columnMapping);
      return compileVectorBinaryOp(expr.op, leftFn, rightFn);
    }

    case BoundExprKind.UNARY: {
      const operandFn = compileVectorExpression(expr.operand, columnMapping);
      if (expr.op === '-') {
        return (chunk: DataChunk) => {
          const operand = operandFn!(chunk);
          return vectorUnaryMinus(operand, chunk);
        };
      }
      if (expr.op === 'NOT') {
        return (chunk: DataChunk) => {
          const operand = operandFn!(chunk);
          return vectorUnaryNot(operand, chunk);
        };
      }
      return operandFn;
    }

    default:
      return null;
  }
}

export function vectorGet(result: VectorResult | null, chunk: DataChunk, i: number): EvalValue {
  if (!result) return null;
  const rowIdx = chunk.selectionVector ? chunk.selectionVector[i] : i;
  if (result.ref) return result.column?.get(rowIdx) ?? null;
  if (result.constant) return result.value;
  if (result.data) return result.data[i];
  return null;
}

export function vectorizedFilter(chunk: DataChunk, scalarEvalFn: CompiledExpr): { sv: Uint32Array; count: number } {
  const size = chunk.size;
  const sv = new Uint32Array(size);
  let count = 0;

  if (chunk.selectionVector) {
    const inputSv = chunk.selectionVector;
    for (let i = 0; i < size; i++) {
      const rowIdx = inputSv[i];
      if (scalarEvalFn(chunk, rowIdx)) {
        sv[count++] = rowIdx;
      }
    }
  } else {
    for (let i = 0; i < size; i++) {
      if (scalarEvalFn(chunk, i)) {
        sv[count++] = i;
      }
    }
  }

  return { sv, count };
}

export function vectorizedHashProbe(probeChunk: DataChunk, probeKeyFn: CompiledExpr, hashTable: Map<string, BuildRef[]>, maxMatches: number = 65536): { buildRefs: BuildRef[]; probeIndices: number[] } {
  const buildRefs: BuildRef[] = [];
  const probeIndices: number[] = [];

  for (let i = 0; i < probeChunk.size; i++) {
    const probeIdx = probeChunk.activeRowIndex(i);
    const key = probeKeyFn(probeChunk, probeIdx);
    if (key === null) continue;

    const keyStr = String(key);
    const matches = hashTable.get(keyStr);
    if (!matches) continue;

    for (const ref of matches) {
      buildRefs.push(ref);
      probeIndices.push(probeIdx);
    }
  }

  return { buildRefs, probeIndices };
}

export function buildJoinOutputDirect(buildChunks: DataChunk[], buildRefs: BuildRef[], probeChunk: DataChunk, probeIndices: number[], buildColCount: number, probeColCount: number): DataChunk {
  const resultSize = buildRefs.length;
  if (resultSize === 0) return new DataChunk([], 0);

  const columns: AnyColumn[] = [];

  for (let c = 0; c < buildColCount; c++) {
    const firstBuildChunk = buildChunks[buildRefs[0].chunkIdx];
    const dt = firstBuildChunk.columns[c]?.dataType || DataType.VARCHAR;
    const col = new Column(dt, resultSize);
    for (let r = 0; r < resultSize; r++) {
      const ref = buildRefs[r];
      col.set(r, buildChunks[ref.chunkIdx].columns[c].get(ref.rowIdx));
    }
    col.length = resultSize;
    columns.push(col);
  }

  for (let c = 0; c < probeColCount; c++) {
    const dt = probeChunk.columns[c]?.dataType || DataType.VARCHAR;
    const col = new Column(dt, resultSize);
    for (let r = 0; r < resultSize; r++) {
      col.set(r, probeChunk.columns[c].get(probeIndices[r]));
    }
    col.length = resultSize;
    columns.push(col);
  }

  return new DataChunk(columns, resultSize);
}

export function vectorizedProject(chunk: DataChunk, evaluators: CompiledExpr[], expressions: (BoundExpr | null)[], resultTypes: DataType[] | null): DataChunk {
  const outputCols: AnyColumn[] = [];

  for (let e = 0; e < evaluators.length; e++) {
    const expr = expressions[e];
    const evalFn = evaluators[e];
    const dataType = resultTypes ? resultTypes[e] : ((getExprType(expr) as DataType) || DataType.VARCHAR);

    if (expr?.kind === BoundExprKind.COLUMN_REF) {
      if (!chunk.selectionVector) {
        outputCols.push(chunk.columns[resolveColIdx(expr, null)] || createEvalColumn(chunk, evalFn, dataType));
        continue;
      }
    }

    outputCols.push(createEvalColumn(chunk, evalFn, dataType));
  }

  return new DataChunk(outputCols, chunk.size);
}

function createEvalColumn(chunk: DataChunk, evalFn: CompiledExpr, dataType: DataType): Column {
  const col = new Column(dataType, chunk.size || 1);
  for (let i = 0; i < chunk.size; i++) {
    const rowIdx = chunk.activeRowIndex(i);
    const val = evalFn(chunk, rowIdx);
    col.set(i, typeof val === 'bigint' && dataType !== DataType.INT64 ? Number(val) : (val as ColumnValue));
  }
  col.length = chunk.size;
  return col;
}


function compileVectorBinaryOp(op: string, leftFn: VectorFn | null, rightFn: VectorFn | null): VectorFn | null {
  return null;
}

function vectorUnaryMinus(operand: VectorResult | null, chunk: DataChunk): VectorResult | null {
  return null;
}

function vectorUnaryNot(operand: VectorResult | null, chunk: DataChunk): VectorResult | null {
  return null;
}
