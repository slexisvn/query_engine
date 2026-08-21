import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { DataType, type ColumnValue } from '../../storage/data-type.js';
import type { BoundExpr, BoundWindowNode } from '../../binder/expression-binder.js';
import { exprKey } from '../../binder/expr-key.js';
import { createKeyedHashTable, hashKeyValues } from '../hash-table.js';
import { RowMemoryBudget } from '../memory-budget.js';
import { PriorityQueue } from '../../utils/priority-queue.js';
import { Config } from '../../config.js';
import { DEFAULT_FRAME, FRAME_AGGREGATORS, frameRangesOf, peerGroupsOf, type FrameRanges } from './window-frame.js';
import { nullsFirstFor, compareOrderedValues } from './sort.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';
import type { CompiledExpr, ColumnMapping, ExecSchema, EvalValue } from '../execution-types.js';

type CompileExpressionFn = (expr: BoundExpr, mapping: ColumnMapping) => CompiledExpr;
type FrameAggregator = (values: EvalValue[], ranges: FrameRanges) => EvalValue[];

const ORDINAL_TYPE = DataType.FLOAT64;
const ROWS_RUN = 'window_rows';
const INPUT_RUN_PREFIX = 'window_in_';
const OUTPUT_RUN_PREFIX = 'window_out_';
const RUN_SEPARATOR = '_';
const SIGNATURE_TERMINATOR = ':';

const COUNT = 'COUNT';
const COUNT_STAR = 'COUNT_STAR';
const ROW_NUMBER = 'ROW_NUMBER';
const RANK = 'RANK';
const DENSE_RANK = 'DENSE_RANK';
const LAG = 'LAG';
const LEAD = 'LEAD';
const ASCENDING = 'ASC';
const DEFAULT_OFFSET = 1;

const VALUE_ARG = 0;
const OFFSET_ARG = 1;
const DEFAULT_ARG = 2;

interface OrderSpec {
  direction: string;
  nullsFirst: boolean;
}

interface WindowPlan {
  node: BoundWindowNode;
  slot: number;
  name: string;
  aggregator: FrameAggregator | null;
  orderSpecs: OrderSpec[];
  orderColumns: number[];
  argColumns: number[];
}

interface WindowGroup {
  evals: CompiledExpr[];
  evalIndex: Map<BoundExpr, number>;
  partitionColumns: number[];
  plans: WindowPlan[];
}

function resultTypeOf(node: BoundWindowNode): DataType {
  const declared = (node.resultType || DataType.INT64) as DataType;
  return declared === DataType.INT64 ? DataType.FLOAT64 : declared;
}

function partitionSignature(partitionBy: readonly BoundExpr[]): string {
  let signature = '';
  for (const expr of partitionBy) {
    const key = exprKey(expr);
    signature += key.length + SIGNATURE_TERMINATOR + key;
  }
  return signature;
}

function columnFor(group: WindowGroup, expr: BoundExpr, mapping: ColumnMapping, compile: CompileExpressionFn): number {
  const existing = group.evalIndex.get(expr);
  if (existing !== undefined) return existing;
  const index = group.evals.length;
  group.evals.push(compile(expr, mapping));
  group.evalIndex.set(expr, index);
  return index;
}

function buildGroups(windowExprs: BoundWindowNode[], mapping: ColumnMapping, compile: CompileExpressionFn): WindowGroup[] {
  const bySignature = new Map<string, WindowGroup>();
  const groups: WindowGroup[] = [];

  for (let slot = 0; slot < windowExprs.length; slot++) {
    const node = windowExprs[slot];
    const signature = partitionSignature(node.partitionBy);
    let group = bySignature.get(signature);
    if (!group) {
      group = { evals: [], evalIndex: new Map(), partitionColumns: [], plans: [] };
      bySignature.set(signature, group);
      groups.push(group);
      for (const expr of node.partitionBy) group.partitionColumns.push(columnFor(group, expr, mapping, compile));
    }

    const owner = group;
    const name = node.name.toUpperCase();
    const aggregatorName = name === COUNT && node.args.length === 0 ? COUNT_STAR : name;
    owner.plans.push({
      node,
      slot,
      name,
      aggregator: (FRAME_AGGREGATORS.get(aggregatorName) as FrameAggregator | undefined) ?? null,
      orderSpecs: node.orderBy.map((key) => ({
        direction: key.direction || ASCENDING,
        nullsFirst: nullsFirstFor(key.direction, key.nullOrder),
      })),
      orderColumns: node.orderBy.map((key) => columnFor(owner, key.expr, mapping, compile)),
      argColumns: node.args.map((arg) => columnFor(owner, arg, mapping, compile)),
    });
  }

  return groups;
}

function materializeEvals(chunks: readonly DataChunk[], evals: readonly CompiledExpr[], rowCount: number): EvalValue[][] {
  const columns: EvalValue[][] = evals.map(() => new Array(rowCount));
  let offset = 0;
  for (const chunk of chunks) {
    for (let r = 0; r < chunk.size; r++) {
      const rowIndex = chunk.activeRowIndex(r);
      for (let e = 0; e < evals.length; e++) columns[e][offset + r] = evals[e](chunk, rowIndex);
    }
    offset += chunk.size;
  }
  return columns;
}

function partitionsOf(columns: EvalValue[][], keyColumns: readonly number[], rowCount: number): number[][] {
  if (keyColumns.length === 0) {
    const single: number[] = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) single[i] = i;
    return [single];
  }

  const table = createKeyedHashTable(keyColumns.length);
  const groups: number[][] = [];
  const key: EvalValue[] = new Array(keyColumns.length);

  for (let i = 0; i < rowCount; i++) {
    for (let c = 0; c < keyColumns.length; c++) key[c] = columns[keyColumns[c]][i];
    const entry = table.findOrInsert(key);
    let group = groups[entry];
    if (!group) {
      group = [];
      groups[entry] = group;
    }
    group.push(i);
  }

  return groups;
}

function sortedPartition(partition: readonly number[], orderColumns: EvalValue[][], specs: readonly OrderSpec[]): number[] {
  return partition.slice().sort((a, b) => {
    for (let k = 0; k < specs.length; k++) {
      const cmp = compareOrderedValues(orderColumns[k][a], orderColumns[k][b], specs[k].direction, specs[k].nullsFirst);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function samePeer(orderColumns: EvalValue[][], rowA: number, rowB: number): boolean {
  for (const column of orderColumns) {
    if (compareOrderedValues(column[rowA], column[rowB], ASCENDING, false) !== 0) return false;
  }
  return true;
}

function ordinalColumnOf(chunk: DataChunk): Column {
  const column = new Column(ORDINAL_TYPE, chunk.size);
  const source = chunk.columns[chunk.columns.length - 1];
  for (let r = 0; r < chunk.size; r++) column.set(r, source.get(chunk.activeRowIndex(r)));
  column.length = chunk.size;
  return column;
}

function taggedChunk(chunk: DataChunk, rows: readonly number[], baseOrdinal: number): DataChunk {
  const size = rows.length;
  const columns: Column[] = new Array(chunk.columns.length + 1);

  for (let c = 0; c < chunk.columns.length; c++) {
    const source = chunk.columns[c];
    const column = new Column(source.dataType, size);
    for (let r = 0; r < size; r++) column.set(r, source.get(rows[r]));
    column.length = size;
    columns[c] = column;
  }

  const ordinals = new Column(ORDINAL_TYPE, size);
  for (let r = 0; r < size; r++) ordinals.set(r, baseOrdinal + rows[r]);
  ordinals.length = size;
  columns[chunk.columns.length] = ordinals;

  return new DataChunk(columns, size);
}

async function* mergeByOrdinal(
  store: ChunkSpillStore,
  prefix: string,
  runCount: number,
  valueCount: number,
): AsyncGenerator<EvalValue[]> {
  const iterators: AsyncGenerator<DataChunk>[] = new Array(runCount);
  const current: (DataChunk | null)[] = new Array(runCount).fill(null);
  const cursor: number[] = new Array(runCount).fill(0);

  const advance = async (run: number): Promise<void> => {
    for (;;) {
      const next = await iterators[run].next();
      if (next.done) {
        current[run] = null;
        return;
      }
      if (next.value.size > 0) {
        current[run] = next.value;
        cursor[run] = 0;
        return;
      }
    }
  };

  for (let run = 0; run < runCount; run++) {
    iterators[run] = store.readChunks(prefix + run);
    await advance(run);
  }

  const ordinalOf = (run: number): number => {
    const chunk = current[run] as DataChunk;
    return chunk.columns[0].get(chunk.activeRowIndex(cursor[run])) as number;
  };

  const pending = new PriorityQueue<number>((a, b) => ordinalOf(a) - ordinalOf(b));
  for (let run = 0; run < runCount; run++) if (current[run]) pending.push(run);

  const values: EvalValue[] = new Array(valueCount);
  while (!pending.isEmpty()) {
    const run = pending.pop() as number;
    const chunk = current[run] as DataChunk;
    const at = chunk.activeRowIndex(cursor[run]);
    for (let v = 0; v < valueCount; v++) values[v] = chunk.columns[v + 1].get(at) as EvalValue;
    yield values;

    cursor[run]++;
    if (cursor[run] >= chunk.size) await advance(run);
    if (current[run]) pending.push(run);
  }
}

export class WindowOperator {
  childSchema: ExecSchema;
  groups: WindowGroup[];
  resultTypes: DataType[];
  spillStore: ChunkSpillStore | null;
  partitionCount: number;
  memoryBudget: RowMemoryBudget;
  resident: DataChunk[];
  overflowed: boolean;
  rowCount: number;
  dispatchedRows: number;
  schema: DataType[] | null;

  constructor(
    windowExprs: BoundWindowNode[],
    childSchema: ExecSchema,
    childColumnMapping: ColumnMapping,
    compileExpressionFn: CompileExpressionFn,
    spillStore: ChunkSpillStore | null = null,
  ) {
    this.childSchema = childSchema;
    this.groups = buildGroups(windowExprs, childColumnMapping, compileExpressionFn);
    this.resultTypes = windowExprs.map(resultTypeOf);
    this.spillStore = spillStore;
    this.partitionCount = Config.windowSpillPartitions;
    this.memoryBudget = new RowMemoryBudget();
    this.resident = [];
    this.overflowed = false;
    this.rowCount = 0;
    this.dispatchedRows = 0;
    this.schema = null;
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
    if (chunk.size === 0) return;
    const flat = chunk.selectionVector ? chunk.flatten() : chunk;

    if (!this.schema) {
      this.schema = flat.columns.map((column) => column.dataType);
      this.memoryBudget.adoptSchema(this.schema);
    }

    this.rowCount += flat.size;

    if (this.overflowed) {
      await this.dispatch(flat);
      return;
    }

    this.resident.push(flat);
    this.memoryBudget.admit(flat.size);
    if (this.memoryBudget.exceeded) await this.overflow();
  }

  async overflow(): Promise<void> {
    if (!this.spillStore || this.overflowed) return;
    this.overflowed = true;

    const pending = this.resident;
    this.resident = [];
    for (const chunk of pending) await this.dispatch(chunk);
    this.memoryBudget.reset();
  }

  async dispatch(chunk: DataChunk): Promise<void> {
    const store = this.spillStore as ChunkSpillStore;
    await store.appendChunk(ROWS_RUN, chunk);

    const baseOrdinal = this.dispatchedRows;
    this.dispatchedRows += chunk.size;

    for (let g = 0; g < this.groups.length; g++) {
      const routes = this.routeRows(chunk, this.groups[g]);
      const prefix = INPUT_RUN_PREFIX + g + RUN_SEPARATOR;
      for (let p = 0; p < routes.length; p++) {
        if (routes[p].length === 0) continue;
        await store.appendChunk(prefix + p, taggedChunk(chunk, routes[p], baseOrdinal));
      }
    }
  }

  routeRows(chunk: DataChunk, group: WindowGroup): number[][] {
    const routes: number[][] = Array.from({ length: this.partitionCount }, () => []);
    const keyColumns = group.partitionColumns;

    if (keyColumns.length === 0) {
      for (let i = 0; i < chunk.size; i++) routes[0].push(chunk.activeRowIndex(i));
      return routes;
    }

    const mask = this.partitionCount - 1;
    const key: EvalValue[] = new Array(keyColumns.length);
    for (let i = 0; i < chunk.size; i++) {
      const rowIndex = chunk.activeRowIndex(i);
      for (let c = 0; c < keyColumns.length; c++) key[c] = group.evals[keyColumns[c]](chunk, rowIndex);
      routes[hashKeyValues(key, keyColumns.length) & mask].push(rowIndex);
    }
    return routes;
  }

  computeGroup(group: WindowGroup, columns: EvalValue[][], rowCount: number): EvalValue[][] {
    const partitions = partitionsOf(columns, group.partitionColumns, rowCount);
    return group.plans.map((plan) => this.computePlan(plan, columns, partitions, rowCount));
  }

  computePlan(plan: WindowPlan, columns: EvalValue[][], partitions: number[][], rowCount: number): EvalValue[] {
    const result: EvalValue[] = new Array(rowCount);
    const orderColumns = plan.orderColumns.map((index) => columns[index]);
    const ordered = orderColumns.length === 0
      ? partitions
      : partitions.map((partition) => sortedPartition(partition, orderColumns, plan.orderSpecs));
    const argValues = plan.argColumns.length > 0 ? columns[plan.argColumns[VALUE_ARG]] : null;

    if (plan.aggregator) {
      const frame = plan.node.frame ?? DEFAULT_FRAME;
      for (const partition of ordered) {
        const values = partition.map((rowIndex) => (argValues ? argValues[rowIndex] : null));
        const peers = peerGroupsOf(partition.length, (a, b) => samePeer(orderColumns, partition[a], partition[b]));
        const computed = plan.aggregator(values, frameRangesOf(frame, partition.length, peers));
        for (let i = 0; i < partition.length; i++) result[partition[i]] = computed[i];
      }
      return result;
    }

    for (const partition of ordered) {
      switch (plan.name) {
        case ROW_NUMBER:
          for (let i = 0; i < partition.length; i++) result[partition[i]] = i + 1;
          break;

        case RANK: {
          let rank = 1;
          for (let i = 0; i < partition.length; i++) {
            if (i > 0 && !samePeer(orderColumns, partition[i], partition[i - 1])) rank = i + 1;
            result[partition[i]] = rank;
          }
          break;
        }

        case DENSE_RANK: {
          let rank = 1;
          for (let i = 0; i < partition.length; i++) {
            if (i > 0 && !samePeer(orderColumns, partition[i], partition[i - 1])) rank++;
            result[partition[i]] = rank;
          }
          break;
        }

        case LAG:
        case LEAD: {
          const step = plan.name === LAG ? -1 : 1;
          const magnitude = plan.argColumns.length > OFFSET_ARG
            ? Number(columns[plan.argColumns[OFFSET_ARG]][partition[0]])
            : DEFAULT_OFFSET;
          const offset = step * magnitude;
          const fallback = plan.argColumns.length > DEFAULT_ARG ? columns[plan.argColumns[DEFAULT_ARG]] : null;

          for (let i = 0; i < partition.length; i++) {
            const source = i + offset;
            if (source >= 0 && source < partition.length) {
              result[partition[i]] = argValues ? argValues[partition[source]] : null;
            } else {
              result[partition[i]] = fallback ? fallback[partition[i]] : null;
            }
          }
          break;
        }

        default:
          for (let i = 0; i < partition.length; i++) result[partition[i]] = null;
      }
    }

    return result;
  }

  outputChunk(chunk: DataChunk, resultColumns: Column[]): DataChunk {
    const childColumns = chunk.columns.slice(0, this.childSchema.length);
    return new DataChunk([...childColumns, ...resultColumns], chunk.size);
  }

  resultColumnsOf(size: number): Column[] {
    return this.resultTypes.map((dataType) => {
      const column = new Column(dataType, size);
      column.length = size;
      return column;
    });
  }

  async *stream(): AsyncGenerator<DataChunk> {
    if (this.overflowed) {
      yield* this.streamSpilled();
      return;
    }

    if (this.rowCount > 0) {
      const slots: EvalValue[][] = new Array(this.resultTypes.length);
      for (const group of this.groups) {
        const columns = materializeEvals(this.resident, group.evals, this.rowCount);
        const computed = this.computeGroup(group, columns, this.rowCount);
        for (let i = 0; i < group.plans.length; i++) slots[group.plans[i].slot] = computed[i];
      }

      let offset = 0;
      for (const chunk of this.resident) {
        const resultColumns = this.resultColumnsOf(chunk.size);
        for (let s = 0; s < slots.length; s++) {
          for (let r = 0; r < chunk.size; r++) resultColumns[s].set(r, slots[s][offset + r] as ColumnValue);
        }
        yield this.outputChunk(chunk, resultColumns);
        offset += chunk.size;
      }
    }

    this.resident = [];
    if (this.spillStore) await this.spillStore.clearAll();
  }

  async *streamSpilled(): AsyncGenerator<DataChunk> {
    const store = this.spillStore as ChunkSpillStore;
    const merged: AsyncGenerator<EvalValue[]>[] = new Array(this.groups.length);

    for (let g = 0; g < this.groups.length; g++) {
      await this.spillGroupResults(g);
      merged[g] = mergeByOrdinal(store, OUTPUT_RUN_PREFIX + g + RUN_SEPARATOR, this.partitionCount, this.groups[g].plans.length);
    }

    for await (const chunk of store.readChunks(ROWS_RUN)) {
      const resultColumns = this.resultColumnsOf(chunk.size);
      for (let r = 0; r < chunk.size; r++) {
        for (let g = 0; g < merged.length; g++) {
          const next = await merged[g].next();
          const values = next.value as EvalValue[];
          const plans = this.groups[g].plans;
          for (let i = 0; i < plans.length; i++) resultColumns[plans[i].slot].set(r, values[i] as ColumnValue);
        }
      }
      yield this.outputChunk(chunk, resultColumns);
    }

    await store.clearAll();
  }

  async spillGroupResults(groupIndex: number): Promise<void> {
    const store = this.spillStore as ChunkSpillStore;
    const group = this.groups[groupIndex];
    const inputPrefix = INPUT_RUN_PREFIX + groupIndex + RUN_SEPARATOR;
    const outputPrefix = OUTPUT_RUN_PREFIX + groupIndex + RUN_SEPARATOR;

    for (let p = 0; p < this.partitionCount; p++) {
      const chunks: DataChunk[] = [];
      let rows = 0;
      for await (const chunk of store.readChunks(inputPrefix + p)) {
        chunks.push(chunk);
        rows += chunk.size;
      }
      if (rows === 0) continue;

      const columns = materializeEvals(chunks, group.evals, rows);
      const computed = this.computeGroup(group, columns, rows);

      let offset = 0;
      for (const chunk of chunks) {
        const outputColumns: Column[] = new Array(group.plans.length + 1);
        outputColumns[0] = ordinalColumnOf(chunk);
        for (let i = 0; i < group.plans.length; i++) {
          const column = new Column(this.resultTypes[group.plans[i].slot], chunk.size);
          for (let r = 0; r < chunk.size; r++) column.set(r, computed[i][offset + r] as ColumnValue);
          column.length = chunk.size;
          outputColumns[i + 1] = column;
        }
        await store.appendChunk(outputPrefix + p, new DataChunk(outputColumns, chunk.size));
        offset += chunk.size;
      }

      await store.clearPartition(inputPrefix + p);
    }
  }
}
