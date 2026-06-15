import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { JoinType } from '../../planner/logical-plan.js';
import { hashValue } from '../../utils/hash.js';
import { heapAllocator } from '../../storage/sab-arena.js';

export function joinKeyOf(extractors: any, chunk: any, rowIdx: any): any {
  if (extractors.length === 1) {
    const val = extractors[0](chunk, rowIdx);
    if (val === null || val === undefined) return null;
    return typeof val === 'bigint' ? Number(val) : val;
  }
  const parts = new Array(extractors.length);
  for (let i = 0; i < extractors.length; i++) {
    const val = extractors[i](chunk, rowIdx);
    if (val === null || val === undefined) return null;
    parts[i] = typeof val === 'bigint' ? Number(val) : val;
  }
  return parts.join('|');
}

export function joinKeyHash(key: any): any {
  return hashValue(key);
}

export function createCombinedRowAdapter(totalCols: any): any {
  const columns = new Array(totalCols);
  const adapter = {
    row: null as any,
    columns,
    setRow(r: any) { this.row = r; },
  };
  for (let c = 0; c < totalCols; c++) {
    columns[c] = { get: () => adapter.row[c] };
  }
  return adapter;
}

export function probeJoinRows(items: any, lookup: any, opts: any): any {
  const { joinType, buildColCount, probeColCount, conditionEvaluator, hasNullKey, onMatched } = opts;
  const adapter = conditionEvaluator ? createCombinedRowAdapter(buildColCount + probeColCount) : null;
  const resultRows: any[] = [];

  for (const item of items) {
    const { row: pRow, key } = item;

    if (key === null) {
      if (joinType === JoinType.LEFT || joinType === JoinType.FULL || joinType === JoinType.ANTI || joinType === JoinType.SINGLE) {
        resultRows.push(new Array(buildColCount).fill(null).concat(pRow));
      }
      continue;
    }

    const bucket = lookup(key);
    let matched = false;

    if (bucket) {
      for (const buildItem of bucket) {
        const bRow = buildItem.row;
        if (adapter) {
          const combined = bRow.concat(pRow);
          adapter.setRow(combined);
          if (!conditionEvaluator(adapter, 0)) continue;
        }

        matched = true;
        if (onMatched) onMatched(buildItem);

        if (joinType === JoinType.SEMI) {
          break;
        } else if (joinType === JoinType.ANTI) {
          break;
        } else if (joinType === JoinType.SINGLE) {
          resultRows.push(bRow.concat(pRow));
          break;
        } else if (joinType === JoinType.MARK) {
          break;
        } else {
          resultRows.push(bRow.concat(pRow));
        }
      }
    }

    if (!matched) {
      if (joinType === JoinType.LEFT || joinType === JoinType.FULL || joinType === JoinType.SINGLE) {
        resultRows.push(new Array(buildColCount).fill(null).concat(pRow));
      } else if (joinType === JoinType.ANTI) {
        resultRows.push(pRow);
      } else if (joinType === JoinType.MARK) {
        resultRows.push(pRow.concat([hasNullKey ? null : false]));
      }
    } else {
      if (joinType === JoinType.SEMI) {
        resultRows.push(pRow);
      } else if (joinType === JoinType.MARK) {
        resultRows.push(pRow.concat([true]));
      }
    }
  }

  return resultRows;
}

export function emitsOnUnmatchedProbe(joinType: any): boolean {
  return joinType === JoinType.LEFT
    || joinType === JoinType.FULL
    || joinType === JoinType.SINGLE
    || joinType === JoinType.ANTI
    || joinType === JoinType.MARK;
}

export function emitsUnmatchedBuild(joinType: any): boolean {
  return joinType === JoinType.LEFT || joinType === JoinType.FULL;
}

export function buildJoinOutputChunk(rows: any, { joinType, buildColCount, buildSchema, probeSchema }: any, allocator: any = heapAllocator): any {
  if (rows.length === 0) {
    return new DataChunk([], 0);
  }

  const isSemiAnti = joinType === JoinType.SEMI || joinType === JoinType.ANTI;
  const isMark = joinType === JoinType.MARK;

  const colCount = rows[0].length;
  const cols = [];
  for (let c = 0; c < colCount; c++) {
    const firstVal = rows.find((r: any) => r[c] !== null)?.[c];
    let dt = 'VARCHAR';
    if (firstVal !== undefined) {
      dt = typeof firstVal === 'bigint' ? 'DECIMAL'
        : typeof firstVal === 'number' ? (Number.isInteger(firstVal) ? 'INT32' : 'FLOAT64')
        : typeof firstVal === 'boolean' ? 'BOOLEAN'
        : 'VARCHAR';
    }

    let finalDt = dt;
    if (isSemiAnti) {
      finalDt = probeSchema?.[c] || dt;
    } else if (isMark && c === colCount - 1) {
      finalDt = 'BOOLEAN';
    } else {
      if (c < buildColCount) {
        finalDt = buildSchema?.[c] || dt;
      } else {
        finalDt = probeSchema?.[c - buildColCount] || dt;
      }
    }

    const col = new Column(finalDt, rows.length, allocator);
    for (let r = 0; r < rows.length; r++) {
      col.set(r, rows[r][c]);
    }
    col.length = rows.length;
    cols.push(col);
  }

  return new DataChunk(cols, rows.length);
}

export function materializeRow(chunk: any, rowIdx: any): any {
  const row = new Array(chunk.columns.length);
  for (let c = 0; c < chunk.columns.length; c++) {
    row[c] = chunk.columns[c].get(rowIdx);
  }
  return row;
}
