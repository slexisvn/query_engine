import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';
import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { JoinType } from '../../planner/logical-plan.js';
import { Config } from '../../config.js';
import { BloomFilter } from '../../utils/bloom-filter.js';
import { hashValue } from '../../utils/hash.js';
import { RowMemoryBudget } from '../memory-budget.js';
import { joinKeyOf, probeJoinRows, buildJoinOutputChunk, materializeRow } from './join-core.js';
import type { DataType, ColumnValue } from '../../storage/data-type.js';
import type { CompiledExpr, EvalValue } from '../execution-types.js';

type JoinKey = ColumnValue;

interface JoinRowAdapterColumn {
  get(): ColumnValue;
}

interface JoinRowAdapter {
  row: ColumnValue[] | null;
  columns: JoinRowAdapterColumn[];
  setRow(r: ColumnValue[]): void;
}

type ConditionEvaluatorLike = (adapter: JoinRowAdapter, rowIdx: number) => EvalValue;

interface BuildItem {
  row: ColumnValue[];
  pIdx?: number;
  rIdx?: number;
}

interface PartitionRow {
  row: ColumnValue[];
  key: JoinKey;
}

interface BuildPartition {
  rows: PartitionRow[];
  spilled: boolean;
  spilledRows: number;
}

interface ProbeItem {
  row: ColumnValue[];
  key: JoinKey;
}

interface JoinSink {
  consume(chunk: DataChunk): Promise<void>;
}

const REPARTITION_SEED_STEP = 0x9e3779b1;

function getPartition(key: JoinKey, depth: number = 0): number {
  let h = hashValue(key) ^ Math.imul(depth, REPARTITION_SEED_STEP);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) % Config.hashJoinPartitions;
}

interface SpilledPartitionTask {
  tag: number;
  buildHandle: string;
  probeHandle: string;
  depth: number;
  buildRows: number;
}

export class HashJoinBuild {
  keyExtractors: CompiledExpr[];
  joinType: JoinType;
  uniqueKeys: boolean;
  buildPreserved: boolean;
  hashTable: Map<JoinKey, BuildItem[]>;
  buildSchema: DataType[] | null;
  hasNullKey: boolean;
  nullKeyRows: ColumnValue[][];
  spillManager: ChunkSpillStore;
  partitions: BuildPartition[];
  memoryBudget: RowMemoryBudget;
  matchedSet: Set<string>;
  runtimeFilter: BloomFilter | null;
  buildRowCount: number;

  constructor(
    keyExtractors: CompiledExpr[],
    joinType: JoinType,
    uniqueKeys: boolean,
    spillManager: ChunkSpillStore,
    buildPreserved: boolean = false,
    runtimeFilterEntries: number = 0,
  ) {
    this.keyExtractors = keyExtractors;
    this.joinType = joinType || JoinType.INNER;
    this.uniqueKeys = !!uniqueKeys;
    this.buildPreserved = !!buildPreserved;
    this.hashTable = new Map();
    this.buildSchema = null;
    this.hasNullKey = false;
    this.nullKeyRows = [];

    this.spillManager = spillManager;
    this.partitions = Array.from({ length: Config.hashJoinPartitions }, () => ({
      rows: [],
      spilled: false,
      spilledRows: 0,
    }));
    this.memoryBudget = new RowMemoryBudget();
    this.matchedSet = new Set();
    this.runtimeFilter = runtimeFilterEntries > 0
      ? new BloomFilter(runtimeFilterEntries, Config.joinRuntimeFilterFalsePositiveRate)
      : null;
    this.buildRowCount = 0;
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
    if (!this.buildSchema) {
      this.buildSchema = chunk.columns.map((c) => c.dataType);
      this.memoryBudget.adoptSchema(this.buildSchema);
    }
    const flat = chunk.selectionVector ? chunk.flatten() : chunk;

    const chunkRows: ColumnValue[][] = new Array(flat.size);
    for (let i = 0; i < flat.size; i++) {
      chunkRows[i] = materializeRow(flat, i);
    }

    for (let i = 0; i < flat.size; i++) {
      const key = this.buildKey(flat, i);
      if (key === null) {
        this.hasNullKey = true;
        if (this.buildPreserved) this.nullKeyRows.push(chunkRows[i]);
        continue;
      }
      const pIdx = getPartition(key);
      const part = this.partitions[pIdx];

      this.recordRuntimeFilterKey(key);
      part.rows.push({ row: chunkRows[i], key });

      if (!part.spilled) {
        this.memoryBudget.admit(1);
      }

      if (part.spilled && part.rows.length >= Config.flushBatchSize) {
        await this.flushPartition(pIdx);
      }
    }

    if (this.memoryBudget.exceeded) {
      let maxPart = -1;
      let maxRows = 0;
      for (let i = 0; i < Config.hashJoinPartitions; i++) {
        if (!this.partitions[i].spilled && this.partitions[i].rows.length > maxRows) {
          maxRows = this.partitions[i].rows.length;
          maxPart = i;
        }
      }
      if (maxPart !== -1) {
        this.partitions[maxPart].spilled = true;
        this.memoryBudget.release(this.partitions[maxPart].rows.length);
        await this.flushPartition(maxPart);
      }
    }
  }

  recordRuntimeFilterKey(key: JoinKey): void {
    this.buildRowCount++;
    this.runtimeFilter?.add(key);
  }

  probeMightMatch(key: JoinKey): boolean {
    return !this.runtimeFilter || this.runtimeFilter.mightContain(key);
  }

  async flushPartition(pIdx: number): Promise<void> {
    const part = this.partitions[pIdx];
    if (part.rows.length === 0) return;
    const chunk = this.rowsToChunk(part.rows.map((r) => r.row));
    await this.spillManager.appendChunk(`build_${pIdx}`, chunk);

    part.spilledRows += part.rows.length;
    part.rows = [];
  }

  spilledPartitionTasks(): SpilledPartitionTask[] {
    const tasks: SpilledPartitionTask[] = [];
    for (let i = 0; i < Config.hashJoinPartitions; i++) {
      const part = this.partitions[i];
      if (!part.spilled) continue;
      tasks.push({
        tag: i,
        buildHandle: `build_${i}`,
        probeHandle: `probe_${i}`,
        depth: 0,
        buildRows: part.spilledRows,
      });
    }
    return tasks;
  }

  rowsToChunk(rows: ColumnValue[][]): DataChunk {
    if (rows.length === 0) return new DataChunk([], 0);
    const colCount = rows[0].length;
    const columns: Column[] = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const col = new Column((this.buildSchema?.[c] || 'VARCHAR') as DataType, rows.length);
      for (let r = 0; r < rows.length; r++) {
        col.set(r, rows[r][c]);
      }
      col.length = rows.length;
      columns[c] = col;
    }
    return new DataChunk(columns, rows.length);
  }

  async finalize(): Promise<void> {
    for (let i = 0; i < Config.hashJoinPartitions; i++) {
      const part = this.partitions[i];
      if (part.spilled && part.rows.length > 0) {
        await this.flushPartition(i);
      }
      if (!part.spilled) {
        for (let r = 0; r < part.rows.length; r++) {
          const item = part.rows[r];
          let bucket = this.hashTable.get(item.key);
          if (this.uniqueKeys && bucket) continue;
          if (!bucket) {
            bucket = [];
            this.hashTable.set(item.key, bucket);
          }
          bucket.push({ row: item.row, pIdx: i, rIdx: r });
        }
      }
    }
  }

  markMatched(packed: BuildItem): void {
    this.matchedSet.add(`${packed.pIdx}_${packed.rIdx}`);
  }

  emitUnmatched(probeColCount: number): ColumnValue[][] {
    const rows: ColumnValue[][] = [];
    for (let i = 0; i < Config.hashJoinPartitions; i++) {
      const part = this.partitions[i];
      if (!part.spilled) {
        for (let r = 0; r < part.rows.length; r++) {
          if (!this.matchedSet.has(`${i}_${r}`)) {
            const outRow = [...part.rows[r].row];
            for (let c = 0; c < probeColCount; c++) outRow.push(null);
            rows.push(outRow);
          }
        }
      }
    }
    for (let n = 0; n < this.nullKeyRows.length; n++) {
      const outRow = [...this.nullKeyRows[n]];
      for (let c = 0; c < probeColCount; c++) outRow.push(null);
      rows.push(outRow);
    }
    return rows;
  }

  probe(key: JoinKey): BuildItem[] | null {
    return this.hashTable.get(key) || null;
  }

  buildKey(chunk: DataChunk, rowIdx: number): JoinKey | null {
    return joinKeyOf(this.keyExtractors, chunk, rowIdx);
  }
}

export class HashJoinProbe {
  buildSide: HashJoinBuild;
  probeKeyExtractors: CompiledExpr[];
  buildColCount: number;
  probeColCount: number;
  joinType: JoinType;
  conditionEvaluator: CompiledExpr | null;
  spillBuffers: ProbeItem[][];
  probeSchema: DataType[] | null;
  repartitionDepthReached: number;
  nextTaskTag: number;
  runtimeFilterRejections: number;
  discardsUnmatchedProbeRows: boolean;

  constructor(buildSide: HashJoinBuild, probeKeyExtractors: CompiledExpr[], buildColCount: number, probeColCount: number, joinType: JoinType = JoinType.INNER, conditionEvaluator: CompiledExpr | null = null) {
    this.buildSide = buildSide;
    this.probeKeyExtractors = probeKeyExtractors;
    this.buildColCount = buildColCount;
    this.probeColCount = probeColCount;
    this.joinType = joinType;
    this.conditionEvaluator = conditionEvaluator;

    this.spillBuffers = Array.from({ length: Config.hashJoinPartitions }, () => []);
    this.probeSchema = null;
    this.repartitionDepthReached = 0;
    this.nextTaskTag = Config.hashJoinPartitions;
    this.runtimeFilterRejections = 0;
    this.discardsUnmatchedProbeRows = joinType === JoinType.INNER || joinType === JoinType.SEMI;
  }

  async init(): Promise<void> {}

  async process(probeChunk: DataChunk): Promise<DataChunk | null> {
    if (!this.probeSchema) {
      this.probeSchema = probeChunk.columns.map((c) => c.dataType);
    }

    const flat = probeChunk.selectionVector ? probeChunk.flatten() : probeChunk;
    const inMemoryRows: ProbeItem[] = [];

    for (let i = 0; i < flat.size; i++) {
      const key = this.extractProbeKey(flat, i);

      if (key === null) {
        inMemoryRows.push({ row: materializeRow(flat, i), key: null });
        continue;
      }

      if (this.discardsUnmatchedProbeRows && !this.buildSide.probeMightMatch(key)) {
        this.runtimeFilterRejections++;
        continue;
      }

      const row = materializeRow(flat, i);
      const pIdx = getPartition(key);
      if (this.buildSide.partitions[pIdx].spilled) {
        this.spillBuffers[pIdx].push({ row, key });
        if (this.spillBuffers[pIdx].length >= Config.flushBatchSize) {
          await this.flushProbePartition(pIdx);
        }
      } else {
        inMemoryRows.push({ row, key });
      }
    }

    if (inMemoryRows.length > 0) {
      return this.executeInMemoryJoin(inMemoryRows);
    }
    return null;
  }

  async flushProbePartition(pIdx: number): Promise<void> {
    const buffer = this.spillBuffers[pIdx];
    if (buffer.length === 0) return;

    const chunk = this.rowsToProbeChunk(buffer.map((r) => r.row));
    await this.buildSide.spillManager.appendChunk(`probe_${pIdx}`, chunk);
    this.spillBuffers[pIdx] = [];
  }

  rowsToProbeChunk(rows: ColumnValue[][]): DataChunk {
    if (rows.length === 0) return new DataChunk([], 0);
    const colCount = rows[0].length;
    const columns: Column[] = new Array(colCount);
    for (let c = 0; c < colCount; c++) {
      const col = new Column((this.probeSchema?.[c] || 'VARCHAR') as DataType, rows.length);
      for (let r = 0; r < rows.length; r++) {
        col.set(r, rows[r][c]);
      }
      col.length = rows.length;
      columns[c] = col;
    }
    return new DataChunk(columns, rows.length);
  }

  executeInMemoryJoin(probeItems: ProbeItem[]): DataChunk {
    const resultRows = probeJoinRows(probeItems, (key: JoinKey) => this.buildSide.probe(key), {
      joinType: this.joinType,
      buildColCount: this.buildColCount,
      probeColCount: this.probeColCount,
      conditionEvaluator: this.conditionEvaluator as ConditionEvaluatorLike | null,
      hasNullKey: this.buildSide.hasNullKey,
      onMatched: (buildItem: BuildItem) => this.buildSide.markMatched(buildItem),
    });

    return this.buildOutputChunk(resultRows);
  }

  async finalize(sink: JoinSink): Promise<void> {
    for (let i = 0; i < Config.hashJoinPartitions; i++) {
      if (this.spillBuffers[i].length > 0) {
        await this.flushProbePartition(i);
      }
    }

    const pending = this.buildSide.spilledPartitionTasks();
    while (pending.length > 0) {
      const task = pending.pop()!;
      this.repartitionDepthReached = Math.max(this.repartitionDepthReached, task.depth);

      if (this.shouldRepartition(task)) {
        for (const sub of await this.repartition(task)) pending.push(sub);
        continue;
      }

      await this.joinSpilledPartition(task, sink);
    }

    await this.buildSide.spillManager.clearAll();
  }

  shouldRepartition(task: SpilledPartitionTask): boolean {
    if (task.depth >= Config.hashJoinMaxRepartitionDepth) return false;
    const budget = new RowMemoryBudget();
    budget.adoptSchema(this.buildSide.buildSchema ?? undefined);
    return task.buildRows > budget.rowCapacity;
  }

  async repartition(task: SpilledPartitionTask): Promise<SpilledPartitionTask[]> {
    const depth = task.depth + 1;
    const spill = this.buildSide.spillManager;
    const buildRows = new Array<number>(Config.hashJoinPartitions).fill(0);
    const touched = new Set<number>();

    for await (const chunk of spill.readChunks(task.buildHandle)) {
      const buckets = this.splitChunkByPartition(chunk, (c, r) => this.buildSide.buildKey(c, r), depth);
      for (const [sub, rows] of buckets) {
        await spill.appendChunk(`${task.buildHandle}_${depth}_${sub}`, this.buildSide.rowsToChunk(rows));
        buildRows[sub] += rows.length;
        touched.add(sub);
      }
    }

    for await (const chunk of spill.readChunks(task.probeHandle)) {
      const buckets = this.splitChunkByPartition(chunk, (c, r) => this.extractProbeKey(c, r), depth);
      for (const [sub, rows] of buckets) {
        await spill.appendChunk(`${task.probeHandle}_${depth}_${sub}`, this.rowsToProbeChunk(rows));
        touched.add(sub);
      }
    }

    await spill.clearPartition(task.buildHandle);
    await spill.clearPartition(task.probeHandle);

    return [...touched].map(sub => ({
      tag: this.nextTaskTag++,
      buildHandle: `${task.buildHandle}_${depth}_${sub}`,
      probeHandle: `${task.probeHandle}_${depth}_${sub}`,
      depth,
      buildRows: buildRows[sub],
    }));
  }

  splitChunkByPartition(
    chunk: DataChunk,
    keyOf: (chunk: DataChunk, rowIdx: number) => JoinKey | null,
    depth: number,
  ): Map<number, ColumnValue[][]> {
    const buckets = new Map<number, ColumnValue[][]>();
    for (let r = 0; r < chunk.size; r++) {
      const key = keyOf(chunk, r);
      if (key === null) continue;
      const sub = getPartition(key, depth);
      let rows = buckets.get(sub);
      if (!rows) {
        rows = [];
        buckets.set(sub, rows);
      }
      rows.push(materializeRow(chunk, r));
    }
    return buckets;
  }

  async joinSpilledPartition(task: SpilledPartitionTask, sink: JoinSink): Promise<void> {
    const build = this.buildSide;
    build.hashTable.clear();

    const buildRows: PartitionRow[] = [];
    for await (const chunk of build.spillManager.readChunks(task.buildHandle)) {
      for (let r = 0; r < chunk.size; r++) {
        const key = build.buildKey(chunk, r);
        if (key === null) continue;
        const row = materializeRow(chunk, r);
        const rIdx = buildRows.length;
        buildRows.push({ row, key });

        let bucket = build.hashTable.get(key);
        if (build.uniqueKeys && bucket) continue;
        if (!bucket) {
          bucket = [];
          build.hashTable.set(key, bucket);
        }
        bucket.push({ row, pIdx: task.tag, rIdx });
      }
    }

    for await (const chunk of build.spillManager.readChunks(task.probeHandle)) {
      const items: ProbeItem[] = new Array(chunk.size);
      for (let r = 0; r < chunk.size; r++) {
        items[r] = { row: materializeRow(chunk, r), key: this.extractProbeKey(chunk, r) };
      }
      const result = this.executeInMemoryJoin(items);
      if (result && result.size > 0) await sink.consume(result);
    }

    if (build.buildPreserved) {
      const unmatched: ColumnValue[][] = [];
      for (let r = 0; r < buildRows.length; r++) {
        if (build.matchedSet.has(`${task.tag}_${r}`)) continue;
        const row = [...buildRows[r].row];
        for (let c = 0; c < this.probeColCount; c++) row.push(null);
        unmatched.push(row);
      }
      if (unmatched.length > 0) await sink.consume(this.buildOutputChunk(unmatched));
    }

    build.hashTable.clear();
  }

  extractProbeKey(chunk: DataChunk, rowIdx: number): JoinKey | null {
    return joinKeyOf(this.probeKeyExtractors, chunk, rowIdx);
  }

  buildOutputChunk(rows: ColumnValue[][]): DataChunk {
    return buildJoinOutputChunk(rows, {
      joinType: this.joinType,
      buildColCount: this.buildColCount,
      buildSchema: this.buildSide.buildSchema ?? undefined,
      probeSchema: this.probeSchema ?? undefined,
    });
  }
}
