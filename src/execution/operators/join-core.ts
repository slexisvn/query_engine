import { Column } from '../../storage/column.js';
import type { DataType, ColumnValue } from '../../storage/data-type.js';
import { DataChunk } from '../../storage/chunk.js';
import { JoinType } from '../../planner/logical-plan.js';
import { hashKeyValues } from '../hash-table.js';
import { heapAllocator } from '../../storage/sab-arena.js';
import type { Allocator } from '../../storage/sab-arena.js';
import type { CompiledExpr, EvalValue } from '../execution-types.js';

export type JoinKey = ColumnValue | ColumnValue[];
type JoinRow = ColumnValue[];

interface RowAdapterColumn {
  get(): ColumnValue;
}

interface RowAdapter {
  row: JoinRow;
  columns: RowAdapterColumn[];
}

type ConditionEvaluator = (adapter: RowAdapter, rowIdx: number) => EvalValue;

interface BuildItem {
  row: JoinRow;
}

interface ProbeItem {
  row: JoinRow;
  key: JoinKey | null;
}

interface ProbeOpts<TBuild extends BuildItem = BuildItem> {
  joinType: JoinType;
  buildColCount: number;
  probeColCount: number;
  conditionEvaluator: ConditionEvaluator | null;
  hasNullKey: boolean;
  onMatched: ((item: TBuild) => void) | null;
}

export interface JoinOutputLayout {
  joinType: JoinType;
  buildColCount: number;
  probeColCount: number;
  buildSchema?: (DataType | string)[];
  probeSchema?: (DataType | string)[];
}

const enum ColumnOrigin { BUILD, PROBE, MARK }

interface OutputColumn {
  origin: ColumnOrigin;
  index: number;
  dataType: DataType | string | null;
}

export function joinKeyOf(extractors: CompiledExpr[], chunk: DataChunk, rowIdx: number): JoinKey | null {
  if (extractors.length === 1) {
    const val = extractors[0](chunk, rowIdx);
    return val === null || val === undefined ? null : (val as ColumnValue);
  }
  const parts: ColumnValue[] = new Array(extractors.length);
  for (let i = 0; i < extractors.length; i++) {
    const val = extractors[i](chunk, rowIdx);
    if (val === null || val === undefined) return null;
    parts[i] = val as ColumnValue;
  }
  return parts;
}

export function joinKeyValues(key: JoinKey, scratch: ColumnValue[]): readonly ColumnValue[] {
  if (Array.isArray(key)) return key;
  scratch[0] = key;
  return scratch;
}

export function joinKeyHash(key: JoinKey, scratch: ColumnValue[]): number {
  const values = joinKeyValues(key, scratch);
  return hashKeyValues(values, values.length);
}

export function createCombinedRowAdapter(totalCols: number): RowAdapter {
  const columns: RowAdapterColumn[] = new Array(totalCols);
  const adapter: RowAdapter = {
    row: new Array<ColumnValue>(totalCols).fill(null),
    columns,
  };
  for (let c = 0; c < totalCols; c++) {
    columns[c] = { get: () => adapter.row[c] };
  }
  return adapter;
}

export function probeJoinInto<TBuild extends BuildItem = BuildItem>(
  items: Iterable<ProbeItem>,
  lookup: (key: JoinKey) => TBuild[] | null,
  opts: ProbeOpts<TBuild>,
  output: JoinOutputBuffer,
): void {
  const { joinType, buildColCount, probeColCount, conditionEvaluator, hasNullKey, onMatched } = opts;
  const adapter = conditionEvaluator ? createCombinedRowAdapter(buildColCount + probeColCount) : null;

  for (const item of items) {
    const { row: pRow, key } = item;

    if (key === null) {
      if (joinType === JoinType.ANTI) {
        output.push(null, pRow);
      } else if (joinType === JoinType.MARK) {
        output.push(null, pRow, null);
      } else if (preservesProbe(joinType)) {
        output.push(null, pRow);
      }
      continue;
    }

    if (adapter) {
      for (let c = 0; c < probeColCount; c++) adapter.row[buildColCount + c] = pRow[c];
    }

    const bucket = lookup(key);
    let matched = false;
    let sawUnknown = false;

    if (bucket) {
      for (const buildItem of bucket) {
        const bRow = buildItem.row;
        if (adapter) {
          for (let c = 0; c < buildColCount; c++) adapter.row[c] = bRow[c];
          const holds = conditionEvaluator!(adapter, 0);
          if (holds === null || holds === undefined) {
            sawUnknown = true;
            continue;
          }
          if (!holds) continue;
        }

        matched = true;
        if (onMatched) onMatched(buildItem);

        if (joinType === JoinType.SEMI) {
          break;
        } else if (joinType === JoinType.ANTI) {
          break;
        } else if (joinType === JoinType.SINGLE) {
          output.push(bRow, pRow);
          break;
        } else if (joinType === JoinType.MARK) {
          break;
        } else {
          output.push(bRow, pRow);
        }
      }
    }

    if (!matched) {
      if (preservesProbe(joinType)) {
        output.push(null, pRow);
      } else if (joinType === JoinType.ANTI) {
        output.push(null, pRow);
      } else if (joinType === JoinType.MARK) {
        output.push(null, pRow, hasNullKey || sawUnknown ? null : false);
      }
    } else {
      if (joinType === JoinType.SEMI) {
        output.push(null, pRow);
      } else if (joinType === JoinType.MARK) {
        output.push(null, pRow, true);
      }
    }
  }
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

function inferDataType(value: ColumnValue): DataType | string {
  if (typeof value === 'bigint') return 'DECIMAL';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INT32' : 'FLOAT64';
  if (typeof value === 'boolean') return 'BOOLEAN';
  return 'VARCHAR';
}

function outputColumnsOf(layout: JoinOutputLayout): OutputColumn[] {
  const { joinType, buildColCount, probeColCount, buildSchema, probeSchema } = layout;
  const probeColumns: OutputColumn[] = [];
  for (let c = 0; c < probeColCount; c++) {
    probeColumns.push({ origin: ColumnOrigin.PROBE, index: c, dataType: probeSchema?.[c] ?? null });
  }

  if (joinType === JoinType.SEMI || joinType === JoinType.ANTI) return probeColumns;
  if (joinType === JoinType.MARK) {
    return [...probeColumns, { origin: ColumnOrigin.MARK, index: 0, dataType: 'BOOLEAN' }];
  }

  const buildColumns: OutputColumn[] = [];
  for (let c = 0; c < buildColCount; c++) {
    buildColumns.push({ origin: ColumnOrigin.BUILD, index: c, dataType: buildSchema?.[c] ?? null });
  }
  return [...buildColumns, ...probeColumns];
}

export class JoinOutputBuffer {
  builds: (JoinRow | null)[];
  probes: (JoinRow | null)[];
  marks: ColumnValue[];
  columns: OutputColumn[];

  constructor(layout: JoinOutputLayout) {
    this.builds = [];
    this.probes = [];
    this.marks = [];
    this.columns = outputColumnsOf(layout);
  }

  get length(): number {
    return this.probes.length;
  }

  push(build: JoinRow | null, probe: JoinRow | null, mark: ColumnValue = null): void {
    this.builds.push(build);
    this.probes.push(probe);
    this.marks.push(mark);
  }

  clear(): void {
    this.builds.length = 0;
    this.probes.length = 0;
    this.marks.length = 0;
  }

  rowsOf(origin: ColumnOrigin): (JoinRow | null)[] {
    return origin === ColumnOrigin.BUILD ? this.builds : this.probes;
  }

  columnDataType(column: OutputColumn, from: number, to: number): DataType | string {
    if (column.dataType !== null) return column.dataType;
    if (column.origin === ColumnOrigin.MARK) return 'BOOLEAN';

    const rows = this.rowsOf(column.origin);
    for (let r = from; r < to; r++) {
      const row = rows[r];
      const value = row ? row[column.index] : null;
      if (value !== null && value !== undefined) return inferDataType(value);
    }
    return 'VARCHAR';
  }

  toChunk(from: number, to: number, allocator: Allocator = heapAllocator): DataChunk {
    const size = to - from;
    if (size <= 0) return new DataChunk([], 0);

    const columns: Column[] = new Array(this.columns.length);
    for (let c = 0; c < this.columns.length; c++) {
      const spec = this.columns[c];
      const column = new Column(this.columnDataType(spec, from, to) as DataType, size, allocator);

      if (spec.origin === ColumnOrigin.MARK) {
        for (let r = 0; r < size; r++) column.set(r, this.marks[from + r]);
      } else {
        const rows = this.rowsOf(spec.origin);
        const index = spec.index;
        for (let r = 0; r < size; r++) {
          const row = rows[from + r];
          column.set(r, row ? row[index] : null);
        }
      }

      column.length = size;
      columns[c] = column;
    }

    return new DataChunk(columns, size);
  }

  *chunks(batchSize: number, allocator: Allocator = heapAllocator): Generator<DataChunk> {
    for (let offset = 0; offset < this.length; offset += batchSize) {
      yield this.toChunk(offset, Math.min(offset + batchSize, this.length), allocator);
    }
  }
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
