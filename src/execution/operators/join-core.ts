import { Column } from '../../storage/column.js';
import type { DataType, ColumnValue } from '../../storage/data-type.js';
import { DataChunk } from '../../storage/chunk.js';
import { JoinType } from '../../planner/logical-plan.js';
import { hashValue } from '../../utils/hash.js';
import { encodeCompositeKey } from '../composite-key.js';
import { heapAllocator } from '../../storage/sab-arena.js';
import type { Allocator } from '../../storage/sab-arena.js';
import type { CompiledExpr, EvalValue } from '../execution-types.js';

type JoinKey = ColumnValue;
type JoinRow = ColumnValue[];

interface RowAdapterColumn {
  get(): ColumnValue;
}

interface RowAdapter {
  row: JoinRow | null;
  columns: RowAdapterColumn[];
  setRow(r: JoinRow): void;
}

type ConditionEvaluator = (adapter: RowAdapter, rowIdx: number) => EvalValue;

interface BuildItem {
  row: JoinRow;
}

interface ProbeItem {
  row: JoinRow;
  key: JoinKey;
}

interface ProbeOpts {
  joinType: JoinType;
  buildColCount: number;
  probeColCount: number;
  conditionEvaluator: ConditionEvaluator | null;
  hasNullKey: boolean;
  onMatched: ((item: BuildItem) => void) | null;
}

interface BuildChunkOpts {
  joinType: JoinType;
  buildColCount: number;
  buildSchema?: (DataType | string)[];
  probeSchema?: (DataType | string)[];
}

export function joinKeyOf(extractors: CompiledExpr[], chunk: DataChunk, rowIdx: number): JoinKey {
  if (extractors.length === 1) {
    const val = extractors[0](chunk, rowIdx);
    if (val === null || val === undefined) return null;
    return typeof val === 'bigint' ? Number(val) : (val as ColumnValue);
  }
  const parts: ColumnValue[] = new Array(extractors.length);
  for (let i = 0; i < extractors.length; i++) {
    const val = extractors[i](chunk, rowIdx);
    if (val === null || val === undefined) return null;
    parts[i] = typeof val === 'bigint' ? Number(val) : (val as ColumnValue);
  }
  return encodeCompositeKey(parts);
}

export function joinKeyHash(key: JoinKey): number {
  return hashValue(key);
}

export function createCombinedRowAdapter(totalCols: number): RowAdapter {
  const columns: RowAdapterColumn[] = new Array(totalCols);
  const adapter: RowAdapter = {
    row: null,
    columns,
    setRow(r: JoinRow) { this.row = r; },
  };
  for (let c = 0; c < totalCols; c++) {
    columns[c] = { get: () => adapter.row![c] };
  }
  return adapter;
}

export function probeJoinRows(items: Iterable<ProbeItem>, lookup: (key: JoinKey) => BuildItem[] | null, opts: ProbeOpts): JoinRow[] {
  const { joinType, buildColCount, probeColCount, conditionEvaluator, hasNullKey, onMatched } = opts;
  const adapter = conditionEvaluator ? createCombinedRowAdapter(buildColCount + probeColCount) : null;
  const resultRows: JoinRow[] = [];

  for (const item of items) {
    const { row: pRow, key } = item;

    if (key === null) {
      if (joinType === JoinType.ANTI) {
        resultRows.push(pRow);
      } else if (joinType === JoinType.MARK) {
        resultRows.push(pRow.concat([null]));
      } else if (preservesProbe(joinType)) {
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
          if (!conditionEvaluator!(adapter, 0)) continue;
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
      if (preservesProbe(joinType)) {
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

export function preservesProbe(joinType: JoinType): boolean {
  return joinType === JoinType.LEFT
    || joinType === JoinType.RIGHT
    || joinType === JoinType.FULL
    || joinType === JoinType.SINGLE;
}

export function emitsOnUnmatchedProbe(joinType: JoinType): boolean {
  return preservesProbe(joinType)
    || joinType === JoinType.ANTI
    || joinType === JoinType.MARK;
}

export function emitsUnmatchedBuild(joinType: JoinType): boolean {
  return joinType === JoinType.LEFT || joinType === JoinType.FULL;
}

export function buildJoinOutputChunk(rows: JoinRow[], { joinType, buildColCount, buildSchema, probeSchema }: BuildChunkOpts, allocator: Allocator = heapAllocator): DataChunk {
  if (rows.length === 0) {
    return new DataChunk([], 0);
  }

  const isSemiAnti = joinType === JoinType.SEMI || joinType === JoinType.ANTI;
  const isMark = joinType === JoinType.MARK;

  const colCount = rows[0].length;
  const cols: Column[] = [];
  for (let c = 0; c < colCount; c++) {
    const firstVal = rows.find((r) => r[c] !== null)?.[c];
    let dt: DataType | string = 'VARCHAR';
    if (firstVal !== undefined) {
      dt = typeof firstVal === 'bigint' ? 'DECIMAL'
        : typeof firstVal === 'number' ? (Number.isInteger(firstVal) ? 'INT32' : 'FLOAT64')
        : typeof firstVal === 'boolean' ? 'BOOLEAN'
        : 'VARCHAR';
    }

    let finalDt: DataType | string = dt;
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

    const col = new Column(finalDt as DataType, rows.length, allocator);
    for (let r = 0; r < rows.length; r++) {
      col.set(r, rows[r][c]);
    }
    col.length = rows.length;
    cols.push(col);
  }

  return new DataChunk(cols, rows.length);
}

export function materializeRow(chunk: DataChunk, rowIdx: number): JoinRow {
  const row = new Array(chunk.columns.length);
  for (let c = 0; c < chunk.columns.length; c++) {
    row[c] = chunk.columns[c].get(rowIdx);
  }
  return row;
}

export function materializeActiveRow(chunk: DataChunk, i: number): JoinRow {
  return materializeRow(chunk, chunk.activeRowIndex(i));
}
