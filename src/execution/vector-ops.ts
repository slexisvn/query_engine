
import { Column } from '../storage/column.js';
import { DataChunk } from '../storage/chunk.js';
import { BoundExprKind } from '../binder/expression-binder.js';
import { DataType, epochDaysToDate, dateToEpochDays } from '../storage/data-type.js';

export function compileVectorExpression(expr: any, columnMapping: any): any {
  if (!expr) return null;

  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF: {
      const colIdx = resolveColIdx(expr, columnMapping);
      return (chunk: any) => ({ ref: true, colIdx, column: chunk.columns[colIdx] });
    }

    case BoundExprKind.LITERAL: {
      const val = expr.value;
      return (chunk: any) => ({ ref: false, constant: true, value: val, size: chunk.size });
    }

    case BoundExprKind.BINARY: {
      const leftFn = compileVectorExpression(expr.left, columnMapping);
      const rightFn = compileVectorExpression(expr.right, columnMapping);
      return compileVectorBinaryOp(expr.op, leftFn, rightFn);
    }

    case BoundExprKind.UNARY: {
      const operandFn = compileVectorExpression(expr.operand, columnMapping);
      if (expr.op === '-') {
        return (chunk: any) => {
          const operand = operandFn(chunk);
          return vectorUnaryMinus(operand, chunk);
        };
      }
      if (expr.op === 'NOT') {
        return (chunk: any) => {
          const operand = operandFn(chunk);
          return vectorUnaryNot(operand, chunk);
        };
      }
      return operandFn;
    }

    default:
      return null;
  }
}

export function vectorGet(result: any, chunk: any, i: number): any {
  if (!result) return null;
  const rowIdx = chunk.selectionVector ? chunk.selectionVector[i] : i;
  if (result.ref) return result.column?.get(rowIdx) ?? null;
  if (result.constant) return result.value;
  if (result.data) return result.data[i];
  return null;
}

export function vectorizedFilter(chunk: any, scalarEvalFn: any): any {
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

export function vectorizedHashProbe(probeChunk: any, probeKeyFn: any, hashTable: any, maxMatches: number = 65536): any {
  const buildRefs: any[] = [];
  const probeIndices: any[] = [];

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

export function buildJoinOutputDirect(buildChunks: any, buildRefs: any, probeChunk: any, probeIndices: any, buildColCount: number, probeColCount: number): any {
  const resultSize = buildRefs.length;
  if (resultSize === 0) return new DataChunk([], 0);

  const columns = [];

  for (let c = 0; c < buildColCount; c++) {
    const firstBuildChunk = buildChunks[buildRefs[0].chunkIdx];
    const dt = firstBuildChunk.columns[c]?.dataType || 'VARCHAR';
    const col = new Column(dt, resultSize);
    for (let r = 0; r < resultSize; r++) {
      const ref = buildRefs[r];
      col.set(r, buildChunks[ref.chunkIdx].columns[c].get(ref.rowIdx));
    }
    col.length = resultSize;
    columns.push(col);
  }

  for (let c = 0; c < probeColCount; c++) {
    const dt = probeChunk.columns[c]?.dataType || 'VARCHAR';
    const col = new Column(dt, resultSize);
    for (let r = 0; r < resultSize; r++) {
      col.set(r, probeChunk.columns[c].get(probeIndices[r]));
    }
    col.length = resultSize;
    columns.push(col);
  }

  return new DataChunk(columns, resultSize);
}

export function vectorizedProject(chunk: any, evaluators: any, expressions: any, resultTypes: any): any {
  const outputCols = [];

  for (let e = 0; e < evaluators.length; e++) {
    const expr = expressions[e];
    const evalFn = evaluators[e];
    const dataType = resultTypes ? resultTypes[e] : (expr?.dataType || expr?.resultType || 'VARCHAR');

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

function createEvalColumn(chunk: any, evalFn: any, dataType: any): any {
  const col = new Column(dataType, chunk.size || 1);
  for (let i = 0; i < chunk.size; i++) {
    const rowIdx = chunk.activeRowIndex(i);
    const val = evalFn(chunk, rowIdx);
    col.set(i, typeof val === 'bigint' && dataType !== 'INT64' ? Number(val) : val);
  }
  col.length = chunk.size;
  return col;
}


function resolveColIdx(expr: any, columnMapping: any): any {
  if (columnMapping) {
    const key = `${expr.tableAlias}.${expr.columnName}`.toUpperCase();
    if (columnMapping.has(key)) return columnMapping.get(key);
    const byName = expr.columnName.toUpperCase();
    if (columnMapping.has(byName)) return columnMapping.get(byName);
  }
  return expr.columnIndex;
}

function compileVectorBinaryOp(op: any, leftFn: any, rightFn: any): any {
  return null;
}

function vectorUnaryMinus(operand: any, chunk: any): any {
  return null;
}

function vectorUnaryNot(operand: any, chunk: any): any {
  return null;
}
