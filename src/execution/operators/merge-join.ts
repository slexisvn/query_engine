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
  row: ColumnValue[];
  columns: RowAdapterColumn[];
}

interface GroupMatch {
  row: JoinRow | null;
  sawUnknown: boolean;
}

type RowEvaluator = (adapter: RowAdapter, rowIdx: number) => EvalValue;

function isNullJoinKey(key: JoinKey): boolean {
  if (key === null || key === undefined) return true;
  return Array.isArray(key) && key.some((part) => part === null || part === undefined);
}

export function mergeJoinSortKeys(keyExtractors: CompiledExpr[]): SortKey[] {
  const keys: SortKey[] = keyExtractors.map((extract) => ({ eval: extract, direction: 'ASC', nullsFirst: true }));
  if (keyExtractors.length === 1) return keys;

  const nullMarker: SortKey = {
    eval: (chunk, rowIdx) => {
      for (const extract of keyExtractors) {
        const value = extract(chunk, rowIdx);
        if (value === null || value === undefined) return 0;
      }
      return 1;
    },
    direction: 'ASC',
    nullsFirst: true,
  };
  return [nullMarker, ...keys];
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

async function collectGroup(cursor: SortedRowCursor, key: JoinKey, group: JoinRow[]): Promise<JoinRow[]> {
  group.length = 0;
  while (cursor.current && !isNullJoinKey(cursor.current.key) && compareJoinKeys(cursor.current.key, key) === 0) {
    group.push(cursor.current);
    await cursor.advance();
  }
  return group;
}

function concatRows(left: ColumnValue[], right: ColumnValue[]): ColumnValue[] {
  const combined = new Array<ColumnValue>(left.length + right.length);
  for (let i = 0; i < left.length; i++) combined[i] = left[i];
  for (let i = 0; i < right.length; i++) combined[left.length + i] = right[i];
  return combined;
}

function appendValue(row: ColumnValue[], value: ColumnValue): ColumnValue[] {
  const combined = new Array<ColumnValue>(row.length + 1);
  for (let i = 0; i < row.length; i++) combined[i] = row[i];
  combined[row.length] = value;
  return combined;
}

function rowWithNullsAfter(row: ColumnValue[], padding: number): ColumnValue[] {
  const combined = new Array<ColumnValue>(row.length + padding);
  for (let i = 0; i < row.length; i++) combined[i] = row[i];
  for (let i = 0; i < padding; i++) combined[row.length + i] = null;
  return combined;
}

function rowWithNullsBefore(row: ColumnValue[], padding: number): ColumnValue[] {
  const combined = new Array<ColumnValue>(padding + row.length);
  for (let i = 0; i < padding; i++) combined[i] = null;
  for (let i = 0; i < row.length; i++) combined[padding + i] = row[i];
  return combined;
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
  private readonly buildGroupScratch: JoinRow[] = [];
  private readonly probeGroupScratch: JoinRow[] = [];
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

  get emitsSingleMatch(): boolean {
    return this.joinType === JoinType.SINGLE;
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
        const buildGroup = await collectGroup(build, groupKey, this.buildGroupScratch);
        const probeGroup = await collectGroup(probe, groupKey, this.probeGroupScratch);
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
        const { row, sawUnknown } = this.firstMatch(buildGroup, probeRow);
        const matched = row !== null;
        if (this.joinType === JoinType.SEMI && matched) this.output.push(probeRow.row);
        else if (this.joinType === JoinType.ANTI && !matched) this.output.push(probeRow.row);
        else if (this.emitsMark) {
          this.output.push(appendValue(probeRow.row, matched ? true : (sawUnknown ? null : this.unmatchedMark)));
        }
      }
      return;
    }

    if (this.emitsSingleMatch) {
      for (const probeRow of probeGroup) {
        const match = this.firstMatch(buildGroup, probeRow).row;
        this.output.push(match ? concatRows(match.row, probeRow.row) : this.probeWithNullBuild(probeRow));
      }
      return;
    }

    for (const buildRow of buildGroup) {
      let matchedAny = false;
      this.bindBuild(buildRow);
      for (const probeRow of probeGroup) {
        this.bindProbe(probeRow);
        if (this.boundConditionValue() !== true) continue;
        this.output.push(concatRows(buildRow.row, probeRow.row));
        matchedAny = true;
      }
      if (!matchedAny) this.emitUnmatchedBuild(buildRow);
    }
  }

  firstMatch(buildGroup: JoinRow[], probeRow: JoinRow): GroupMatch {
    if (this.evaluateCondition === null) {
      return { row: buildGroup.length > 0 ? buildGroup[0] : null, sawUnknown: false };
    }

    this.bindProbe(probeRow);
    let sawUnknown = false;
    for (const buildRow of buildGroup) {
      this.bindBuild(buildRow);
      const holds = this.boundConditionValue();
      if (holds === null) sawUnknown = true;
      else if (holds) return { row: buildRow, sawUnknown };
    }
    return { row: null, sawUnknown };
  }

  bindBuild(buildRow: JoinRow): void {
    if (this.adapter === null) return;
    const combined = this.adapter.row;
    const source = buildRow.row;
    for (let c = 0; c < source.length; c++) combined[c] = source[c];
  }

  bindProbe(probeRow: JoinRow): void {
    if (this.adapter === null) return;
    const combined = this.adapter.row;
    const source = probeRow.row;
    const base = this.buildColCount;
    for (let c = 0; c < source.length; c++) combined[base + c] = source[c];
  }

  boundConditionValue(): boolean | null {
    if (this.adapter === null || this.evaluateCondition === null) return true;
    const result = this.evaluateCondition(this.adapter, 0);
    if (result === null || result === undefined) return null;
    return !!result;
  }

  emitUnmatchedBuild(buildRow: JoinRow): void {
    if (!this.keepsUnmatchedBuild) return;
    this.output.push(rowWithNullsAfter(buildRow.row, this.probeColCount));
  }

  emitUnmatchedProbe(probeRow: JoinRow, mark: ColumnValue): void {
    if (this.joinType === JoinType.ANTI) {
      this.output.push(probeRow.row);
      return;
    }
    if (this.emitsMark) {
      this.output.push(appendValue(probeRow.row, mark));
      return;
    }
    if (this.joinType === JoinType.FULL || this.emitsSingleMatch) {
      this.output.push(this.probeWithNullBuild(probeRow));
    }
  }

  probeWithNullBuild(probeRow: JoinRow): ColumnValue[] {
    return rowWithNullsBefore(probeRow.row, this.buildColCount);
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
      row: new Array<ColumnValue>(totalCols).fill(null),
      columns,
    };
    for (let c = 0; c < totalCols; c++) {
      columns[c] = { get: () => adapter.row[c] };
    }
    return adapter;
  }
}
