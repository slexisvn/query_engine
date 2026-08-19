import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { JoinType } from '../../planner/logical-plan.js';
import { Config } from '../../config.js';
import { DataType, type ColumnValue } from '../../storage/data-type.js';
import type { CompiledExpr, EvalValue } from '../execution-types.js';
import { materializeRow } from './join-core.js';
import type { SortKey } from './sort.js';

type JoinKey = EvalValue | EvalValue[];

export type SortedChunkSource = () => AsyncIterable<DataChunk>;

interface JoinRow {
  row: ColumnValue[];
  key: JoinKey;
}

interface RowAdapterColumn {
  get(): ColumnValue;
}

interface RowAdapter {
  row: ColumnValue[] | null;
  columns: RowAdapterColumn[];
  setRow(r: ColumnValue[]): void;
}

type RowEvaluator = (adapter: RowAdapter, rowIdx: number) => EvalValue;

function isNullJoinKey(key: JoinKey): boolean {
  if (key === null || key === undefined) return true;
  return Array.isArray(key) && key.some((part) => part === null || part === undefined);
}

export function mergeJoinSortKeys(keyExtractors: CompiledExpr[]): SortKey[] {
  const nullsFirst: SortKey = {
    eval: (chunk, rowIdx) => (isNullJoinKey(keyExtractors.map((extract) => extract(chunk, rowIdx))) ? 0 : 1),
    direction: 'ASC',
  };
  return [nullsFirst, ...keyExtractors.map((extract) => ({ eval: extract, direction: 'ASC' }))];
}

function compareScalars(a: EvalValue, b: EvalValue): number {
  const left = typeof a === 'bigint' ? Number(a) : a;
  const right = typeof b === 'bigint' ? Number(b) : b;
  if ((left as number) < (right as number)) return -1;
  if ((left as number) > (right as number)) return 1;
  return 0;
}

function compareJoinKeys(k1: JoinKey, k2: JoinKey): number {
  if (Array.isArray(k1)) {
    const left = k1;
    const right = k2 as EvalValue[];
    for (let i = 0; i < left.length; i++) {
      const cmp = compareScalars(left[i], right[i]);
      if (cmp !== 0) return cmp;
    }
    return 0;
  }
  return compareScalars(k1 as EvalValue, k2 as EvalValue);
}

class SortedRowCursor {
  current: JoinRow | null;
  private iterator: AsyncIterator<DataChunk>;
  private chunk: DataChunk | null;
  private index: number;
  private extractors: CompiledExpr[];
  private label: string;

  constructor(source: SortedChunkSource, extractors: CompiledExpr[], label: string) {
    this.iterator = source()[Symbol.asyncIterator]();
    this.chunk = null;
    this.index = 0;
    this.extractors = extractors;
    this.label = label;
    this.current = null;
  }

  async advance(): Promise<void> {
    const previous = this.current;

    while (this.chunk === null || this.index >= this.chunk.size) {
      const next = await this.iterator.next();
      if (next.done) {
        this.current = null;
        return;
      }
      this.chunk = next.value;
      this.index = 0;
    }

    const chunk = this.chunk;
    const rowIndex = chunk.activeRowIndex(this.index);
    this.index++;

    this.current = {
      row: materializeRow(chunk, rowIndex),
      key: this.extractors.length === 1
        ? this.extractors[0](chunk, rowIndex)
        : this.extractors.map((extract) => extract(chunk, rowIndex)),
    };

    this.assertNonDescending(previous, this.current);
  }

  private assertNonDescending(previous: JoinRow | null, next: JoinRow): void {
    if (previous === null || isNullJoinKey(previous.key)) return;
    if (isNullJoinKey(next.key)) return;
    if (compareJoinKeys(previous.key, next.key) <= 0) return;
    throw new Error(`Merge join received unsorted ${this.label} input`);
  }
}

async function collectGroup(cursor: SortedRowCursor, key: JoinKey): Promise<JoinRow[]> {
  const group: JoinRow[] = [];
  while (cursor.current && !isNullJoinKey(cursor.current.key) && compareJoinKeys(cursor.current.key, key) === 0) {
    group.push(cursor.current);
    await cursor.advance();
  }
  return group;
}

export class MergeJoinOperator {
  buildSource: SortedChunkSource;
  probeSource: SortedChunkSource;
  buildKeyExtractors: CompiledExpr[];
  probeKeyExtractors: CompiledExpr[];
  buildTypes: DataType[];
  probeTypes: DataType[];
  joinType: JoinType;
  conditionEvaluator: CompiledExpr | null;

  private output: ColumnValue[][];
  private adapter: RowAdapter | null;
  private evaluateCondition: RowEvaluator | null;
  private buildHasNullKey: boolean;

  constructor(
    buildSource: SortedChunkSource,
    probeSource: SortedChunkSource,
    buildKeyExtractors: CompiledExpr[],
    probeKeyExtractors: CompiledExpr[],
    buildTypes: DataType[],
    probeTypes: DataType[],
    joinType: JoinType = JoinType.INNER,
    conditionEvaluator: CompiledExpr | null = null,
  ) {
    this.buildSource = buildSource;
    this.probeSource = probeSource;
    this.buildKeyExtractors = buildKeyExtractors;
    this.probeKeyExtractors = probeKeyExtractors;
    this.buildTypes = buildTypes;
    this.probeTypes = probeTypes;
    this.joinType = joinType;
    this.conditionEvaluator = conditionEvaluator;
    this.output = [];
    this.adapter = conditionEvaluator ? this.createAdapter() : null;
    this.evaluateCondition = conditionEvaluator as RowEvaluator | null;
    this.buildHasNullKey = false;
  }

  get buildColCount(): number {
    return this.buildTypes.length;
  }

  get probeColCount(): number {
    return this.probeTypes.length;
  }

  get emitsProbeOnly(): boolean {
    return this.joinType === JoinType.SEMI || this.joinType === JoinType.ANTI;
  }

  get emitsMark(): boolean {
    return this.joinType === JoinType.MARK;
  }

  get keepsUnmatchedBuild(): boolean {
    return this.joinType === JoinType.LEFT
      || this.joinType === JoinType.RIGHT
      || this.joinType === JoinType.FULL;
  }

  get unmatchedMark(): ColumnValue {
    return this.buildHasNullKey ? null : false;
  }

  async *execute(): AsyncGenerator<DataChunk> {
    const build = new SortedRowCursor(this.buildSource, this.buildKeyExtractors, 'build side');
    const probe = new SortedRowCursor(this.probeSource, this.probeKeyExtractors, 'probe side');

    await build.advance();
    await probe.advance();

    while (build.current && isNullJoinKey(build.current.key)) {
      this.buildHasNullKey = true;
      this.emitUnmatchedBuild(build.current);
      yield* this.drain();
      await build.advance();
    }

    while (probe.current && isNullJoinKey(probe.current.key)) {
      this.emitUnmatchedProbe(probe.current, null);
      yield* this.drain();
      await probe.advance();
    }

    while (build.current && probe.current) {
      const cmp = compareJoinKeys(build.current.key, probe.current.key);

      if (cmp < 0) {
        this.emitUnmatchedBuild(build.current);
        await build.advance();
      } else if (cmp > 0) {
        this.emitUnmatchedProbe(probe.current, this.unmatchedMark);
        await probe.advance();
      } else {
        const groupKey = build.current.key;
        const buildGroup = await collectGroup(build, groupKey);
        const probeGroup = await collectGroup(probe, groupKey);
        this.emitGroup(buildGroup, probeGroup);
      }

      yield* this.drain();
    }

    while (build.current) {
      this.emitUnmatchedBuild(build.current);
      yield* this.drain();
      await build.advance();
    }

    while (probe.current) {
      const mark = isNullJoinKey(probe.current.key) ? null : this.unmatchedMark;
      this.emitUnmatchedProbe(probe.current, mark);
      yield* this.drain();
      await probe.advance();
    }

    yield* this.flush();
  }

  emitGroup(buildGroup: JoinRow[], probeGroup: JoinRow[]): void {
    if (this.emitsProbeOnly || this.emitsMark) {
      for (const probeRow of probeGroup) {
        const matched = buildGroup.some((buildRow) => this.conditionHolds(buildRow, probeRow));
        if (this.joinType === JoinType.SEMI && matched) this.output.push(probeRow.row);
        else if (this.joinType === JoinType.ANTI && !matched) this.output.push(probeRow.row);
        else if (this.emitsMark) this.output.push([...probeRow.row, matched ? true : this.unmatchedMark]);
      }
      return;
    }

    for (const buildRow of buildGroup) {
      let matchedAny = false;
      for (const probeRow of probeGroup) {
        if (!this.conditionHolds(buildRow, probeRow)) continue;
        this.output.push([...buildRow.row, ...probeRow.row]);
        matchedAny = true;
      }
      if (!matchedAny) this.emitUnmatchedBuild(buildRow);
    }
  }

  conditionHolds(buildRow: JoinRow, probeRow: JoinRow): boolean {
    if (!this.adapter || !this.evaluateCondition) return true;
    this.adapter.setRow([...buildRow.row, ...probeRow.row]);
    return !!this.evaluateCondition(this.adapter, 0);
  }

  emitUnmatchedBuild(buildRow: JoinRow): void {
    if (!this.keepsUnmatchedBuild) return;
    this.output.push([...buildRow.row, ...new Array<ColumnValue>(this.probeColCount).fill(null)]);
  }

  emitUnmatchedProbe(probeRow: JoinRow, mark: ColumnValue): void {
    if (this.joinType === JoinType.ANTI) {
      this.output.push(probeRow.row);
      return;
    }
    if (this.emitsMark) {
      this.output.push([...probeRow.row, mark]);
      return;
    }
    if (this.joinType === JoinType.FULL) {
      this.output.push([...new Array<ColumnValue>(this.buildColCount).fill(null), ...probeRow.row]);
    }
  }

  *drain(): Generator<DataChunk> {
    while (this.output.length >= Config.flushBatchSize) {
      yield this.toChunk(this.output.splice(0, Config.flushBatchSize));
    }
  }

  *flush(): Generator<DataChunk> {
    if (this.output.length === 0) return;
    const rows = this.output;
    this.output = [];
    yield this.toChunk(rows);
  }

  outputTypes(): DataType[] {
    if (this.emitsProbeOnly) return this.probeTypes;
    if (this.emitsMark) return [...this.probeTypes, DataType.BOOLEAN];
    return [...this.buildTypes, ...this.probeTypes];
  }

  toChunk(rows: ColumnValue[][]): DataChunk {
    const columns = this.outputTypes().map((dataType) => new Column(dataType, rows.length));

    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < columns.length; c++) columns[c].set(r, rows[r][c]);
    }
    for (const column of columns) column.length = rows.length;

    return new DataChunk(columns, rows.length);
  }

  createAdapter(): RowAdapter {
    const totalCols = this.buildTypes.length + this.probeTypes.length;
    const columns: RowAdapterColumn[] = new Array(totalCols);
    const adapter: RowAdapter = {
      row: null,
      columns,
      setRow(r: ColumnValue[]) { this.row = r; },
    };
    for (let c = 0; c < totalCols; c++) {
      columns[c] = { get: () => adapter.row![c] };
    }
    return adapter;
  }
}
