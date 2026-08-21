import { DictionaryColumn } from '../../storage/dictionary-column.js';
import { Column } from '../../storage/column.js';
import { DataType } from '../../storage/data-type.js';
import { DataChunk } from '../../storage/chunk.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr, BoundColumnRefNode } from '../../binder/expression-binder.js';
import { testBit } from '../../utils/bitmap.js';
import { hashKeyValues } from '../hash-table.js';
import type { PartialGroup } from './aggregate-state-codec.js';
import { Config } from '../../config.js';
import { schemaMappingOf, resolveRef, StageKind } from '../fragment-spec.js';

const OP: Record<string, number> = { SUM: 0, COUNT: 1, COUNT_STAR: 2, AVG: 3, MIN: 4, MAX: 5 };
const INT_KEY_TYPES = new Set<DataType>([DataType.INT32, DataType.DATE]);
const NUMERIC_VALUE_TYPES = new Set<DataType>([DataType.INT32, DataType.FLOAT64, DataType.DATE]);
const INITIAL_SLOTS = 1024;

enum KeyKind {
  INT = 'int',
  DICT = 'dict',
}

interface AggDescriptor {
  op: number;
  colIdx: number;
}

interface AggState {
  sums?: Float64Array;
  counts?: Float64Array;
  vals?: Float64Array;
  has?: Uint8Array;
}

interface AvgState {
  sum: number;
  count: number;
}

type SlotState = number | AvgState | null;

interface VectorSpecSchemaColumn {
  name: string;
  dataType: DataType;
  tableAlias?: string;
}

interface VectorSpecAggregate {
  name: string;
  distinct: boolean;
  args: BoundExpr[];
}

interface VectorSpecStage {
  kind: StageKind;
}

interface VectorSpecSource {
  stages: VectorSpecStage[];
  baseSchema: VectorSpecSchemaColumn[];
}

interface VectorSpec {
  groupBy: BoundExpr[];
  source: VectorSpecSource;
  aggregates: VectorSpecAggregate[];
}

export function createVectorAggregator(spec: VectorSpec): VectorGroupAggregator | null {
  if (spec.groupBy.length !== 1) return null;
  for (const stage of spec.source.stages) {
    if (stage.kind !== StageKind.FILTER) return null;
  }

  const mapping = schemaMappingOf(spec.source.baseSchema);
  const groupExpr = spec.groupBy[0];
  if (groupExpr?.kind !== BoundExprKind.COLUMN_REF) return null;
  const groupIdx = resolveRef(groupExpr, mapping);
  if (groupIdx === undefined) return null;

  const groupType = spec.source.baseSchema[groupIdx].dataType;
  const keyKind = groupType === DataType.VARCHAR
    ? KeyKind.DICT
    : INT_KEY_TYPES.has(groupType) ? KeyKind.INT : null;
  if (!keyKind) return null;

  const aggs: AggDescriptor[] = [];
  for (const agg of spec.aggregates) {
    const op = OP[(agg.name || '').toUpperCase()];
    if (op === undefined || agg.distinct) return null;
    if (op === OP.COUNT_STAR) {
      aggs.push({ op, colIdx: -1 });
      continue;
    }
    if (!agg.args || agg.args.length !== 1 || agg.args[0]?.kind !== BoundExprKind.COLUMN_REF) return null;
    const colIdx = resolveRef(agg.args[0] as BoundColumnRefNode, mapping);
    if (colIdx === undefined) return null;
    if (!NUMERIC_VALUE_TYPES.has(spec.source.baseSchema[colIdx].dataType)) return null;
    aggs.push({ op, colIdx });
  }

  return new VectorGroupAggregator(keyKind, groupIdx, aggs);
}

function makeAggState(op: number, capacity: number): AggState {
  switch (op) {
    case OP.SUM:
      return { sums: new Float64Array(capacity), has: new Uint8Array(capacity) };
    case OP.COUNT:
    case OP.COUNT_STAR:
      return { counts: new Float64Array(capacity) };
    case OP.AVG:
      return { sums: new Float64Array(capacity), counts: new Float64Array(capacity) };
    default:
      return { vals: new Float64Array(capacity), has: new Uint8Array(capacity) };
  }
}

function growAggState(op: number, state: AggState, capacity: number): AggState {
  const grown = makeAggState(op, capacity);
  for (const field of Object.keys(grown) as (keyof AggState)[]) {
    grown[field]!.set(state[field]!);
  }
  return grown;
}

function exportSlotState(op: number, state: AggState, slot: number): SlotState {
  switch (op) {
    case OP.SUM:
      return state.has![slot] ? state.sums![slot] : null;
    case OP.COUNT:
    case OP.COUNT_STAR:
      return state.counts![slot];
    case OP.AVG:
      return { sum: state.sums![slot], count: state.counts![slot] };
    default:
      return state.has![slot] ? state.vals![slot] : null;
  }
}

export class VectorGroupAggregator {
  keyKind: KeyKind;
  groupIdx: number;
  aggs: AggDescriptor[];
  capacity!: number;
  used!: number;
  slotKeys!: (number | string | null)[];
  nullSlot!: number;
  stringSlots!: Map<string, number> | null;
  denseBase!: number;
  dense!: Int32Array;
  state!: AggState[];

  constructor(keyKind: KeyKind, groupIdx: number, aggs: AggDescriptor[]) {
    this.keyKind = keyKind;
    this.groupIdx = groupIdx;
    this.aggs = aggs;
    this.clear();
  }

  clear(): void {
    this.capacity = INITIAL_SLOTS;
    this.used = 0;
    this.slotKeys = new Array(this.capacity);
    this.nullSlot = -1;
    this.stringSlots = this.keyKind === KeyKind.DICT ? new Map() : null;
    this.denseBase = 0;
    this.dense = this.keyKind === KeyKind.INT ? new Int32Array(0) : new Int32Array(0);
    this.state = this.aggs.map((agg) => makeAggState(agg.op, this.capacity));
  }

  get groupCount(): number {
    return this.used;
  }

  _allocSlot(key: number | string | null): number {
    if (this.used === this.capacity) {
      this.capacity *= 2;
      this.slotKeys.length = this.capacity;
      this.state = this.state.map((state, a) => growAggState(this.aggs[a].op, state, this.capacity));
    }
    const slot = this.used++;
    this.slotKeys[slot] = key;
    return slot;
  }

  _nullSlot(): number {
    if (this.nullSlot < 0) {
      this.nullSlot = this._allocSlot(null);
    }
    return this.nullSlot;
  }

  _dictRemap(col: DictionaryColumn): Int32Array {
    const dictLen = col.reverseDict.length;
    const remap = new Int32Array(dictLen);
    for (let d = 0; d < dictLen; d++) {
      const value = col.reverseDict[d];
      let slot = this.stringSlots!.get(value);
      if (slot === undefined) {
        slot = this._allocSlot(value);
        this.stringSlots!.set(value, slot);
      }
      remap[d] = slot;
    }
    return remap;
  }

  _ensureDenseRange(chunk: DataChunk, col: Column): boolean {
    const size = chunk.size;
    const sv = chunk.selectionVector;
    const data = col.data as Int32Array;
    const hasNulls = col.hasNulls;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < size; i++) {
      const phys = sv ? sv[i] : i;
      if (hasNulls && !testBit(col.nullBitmap, phys)) continue;
      const v = data[phys];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return true;

    if (this.dense.length === 0) {
      const range = max - min + 1;
      if (range > Config.vectorGroupRange) return false;
      this.denseBase = min;
      this.dense = new Int32Array(range);
      return true;
    }

    const newBase = Math.min(this.denseBase, min);
    const newEnd = Math.max(this.denseBase + this.dense.length - 1, max);
    const newRange = newEnd - newBase + 1;
    if (newBase === this.denseBase && newRange === this.dense.length) return true;
    if (newRange > Config.vectorGroupRange) return false;
    const grown = new Int32Array(newRange);
    grown.set(this.dense, this.denseBase - newBase);
    this.denseBase = newBase;
    this.dense = grown;
    return true;
  }

  consume(chunk: DataChunk): boolean {
    const groupColRaw = chunk.columns[this.groupIdx];
    if (this.keyKind === KeyKind.DICT) {
      if (!(groupColRaw instanceof DictionaryColumn)) return false;
    } else if (!groupColRaw || !(groupColRaw as Column).data) {
      return false;
    }

    const valueCols: Column[] = new Array(this.aggs.length);
    const valueData: Float64Array[] = new Array(this.aggs.length);
    for (let a = 0; a < this.aggs.length; a++) {
      if (this.aggs[a].colIdx < 0) continue;
      const col = chunk.columns[this.aggs[a].colIdx] as Column;
      if (!col || !col.data) return false;
      valueCols[a] = col;
      valueData[a] = col.data as Float64Array;
    }

    if (this.keyKind === KeyKind.INT && !this._ensureDenseRange(chunk, groupColRaw as Column)) return false;
    const remap = this.keyKind === KeyKind.DICT ? this._dictRemap(groupColRaw as DictionaryColumn) : null;

    const size = chunk.size;
    const sv = chunk.selectionVector;
    const gHasNulls = groupColRaw.hasNulls;
    const gBitmap = groupColRaw.nullBitmap;
    const gData = remap ? (groupColRaw as DictionaryColumn).indices : ((groupColRaw as Column).data as Int32Array);

    for (let i = 0; i < size; i++) {
      const phys = sv ? sv[i] : i;
      let slot: number;
      if (gHasNulls && !testBit(gBitmap, phys)) {
        slot = this._nullSlot();
      } else if (remap) {
        slot = remap[gData[phys]];
      } else {
        const pos = gData[phys] - this.denseBase;
        let stored = this.dense[pos];
        if (stored === 0) {
          stored = this._allocSlot(gData[phys]) + 1;
          this.dense[pos] = stored;
        }
        slot = stored - 1;
      }

      for (let a = 0; a < this.aggs.length; a++) {
        const agg = this.aggs[a];
        const state = this.state[a];
        if (agg.op === OP.COUNT_STAR) {
          state.counts![slot]++;
          continue;
        }
        const col = valueCols[a];
        if (col.hasNulls && !testBit(col.nullBitmap, phys)) continue;
        const v = valueData[a][phys];
        if (agg.op === OP.SUM) {
          state.sums![slot] += v;
          state.has![slot] = 1;
        } else if (agg.op === OP.COUNT) {
          state.counts![slot]++;
        } else if (agg.op === OP.AVG) {
          state.sums![slot] += v;
          state.counts![slot]++;
        } else if (agg.op === OP.MIN) {
          if (!state.has![slot] || v < state.vals![slot]) {
            state.vals![slot] = v;
            state.has![slot] = 1;
          }
        } else if (!state.has![slot] || v > state.vals![slot]) {
          state.vals![slot] = v;
          state.has![slot] = 1;
        }
      }
    }
    return true;
  }

  exportPartials(partitionCount: number): PartialGroup[][] {
    const mask = partitionCount - 1;
    const partitions: PartialGroup[][] = Array.from({ length: partitionCount }, () => []);
    const keyParts: (number | string | null)[] = [null];
    for (let slot = 0; slot < this.used; slot++) {
      keyParts[0] = this.slotKeys[slot];
      partitions[hashKeyValues(keyParts, 1) & mask].push({
        groupValues: [keyParts[0]],
        states: this.aggs.map((agg, a) => exportSlotState(agg.op, this.state[a], slot)),
      });
    }
    return partitions;
  }
}
