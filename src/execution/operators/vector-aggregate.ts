import { DictionaryColumn } from '../../storage/dictionary-column.js';
import { DataType } from '../../storage/data-type.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { testBit } from '../../utils/bitmap.js';
import { hashValue } from '../../utils/hash.js';
import { Config } from '../../config.js';
import { schemaMappingOf, resolveRef, StageKind } from '../fragment-spec.js';

const OP: Record<string, number> = { SUM: 0, COUNT: 1, COUNT_STAR: 2, AVG: 3, MIN: 4, MAX: 5 };
const INT_KEY_TYPES = new Set([DataType.INT32, DataType.DATE]);
const NUMERIC_VALUE_TYPES = new Set([DataType.INT32, DataType.FLOAT64, DataType.DATE]);
const INITIAL_SLOTS = 1024;

enum KeyKind {
  INT = 'int',
  DICT = 'dict',
}

export function createVectorAggregator(spec: any): any {
  if (spec.groupBy.length !== 1) return null;
  for (const stage of spec.stages) {
    if (stage.kind !== StageKind.FILTER) return null;
  }

  const mapping = schemaMappingOf(spec.baseSchema);
  const groupExpr = spec.groupBy[0];
  if (groupExpr?.kind !== BoundExprKind.COLUMN_REF) return null;
  const groupIdx = resolveRef(groupExpr, mapping);
  if (groupIdx === undefined) return null;

  const groupType = spec.baseSchema[groupIdx].dataType;
  const keyKind = groupType === DataType.VARCHAR
    ? KeyKind.DICT
    : INT_KEY_TYPES.has(groupType) ? KeyKind.INT : null;
  if (!keyKind) return null;

  const aggs: any[] = [];
  for (const agg of spec.aggregates) {
    const op = OP[(agg.name || '').toUpperCase()];
    if (op === undefined || agg.distinct) return null;
    if (op === OP.COUNT_STAR) {
      aggs.push({ op, colIdx: -1 });
      continue;
    }
    if (!agg.args || agg.args.length !== 1 || agg.args[0]?.kind !== BoundExprKind.COLUMN_REF) return null;
    const colIdx = resolveRef(agg.args[0], mapping);
    if (colIdx === undefined) return null;
    if (!NUMERIC_VALUE_TYPES.has(spec.baseSchema[colIdx].dataType)) return null;
    aggs.push({ op, colIdx });
  }

  return new VectorGroupAggregator(keyKind, groupIdx, aggs);
}

function makeAggState(op: any, capacity: any): any {
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

function growAggState(op: any, state: any, capacity: any): any {
  const grown = makeAggState(op, capacity);
  for (const field of Object.keys(grown)) {
    grown[field].set(state[field]);
  }
  return grown;
}

function exportSlotState(op: any, state: any, slot: any): any {
  switch (op) {
    case OP.SUM:
      return state.has[slot] ? state.sums[slot] : null;
    case OP.COUNT:
    case OP.COUNT_STAR:
      return state.counts[slot];
    case OP.AVG:
      return { sum: state.sums[slot], count: state.counts[slot] };
    default:
      return state.has[slot] ? state.vals[slot] : null;
  }
}

export class VectorGroupAggregator {
  keyKind: any;
  groupIdx: any;
  aggs: any;
  capacity!: number;
  used!: number;
  slotKeys!: any[];
  nullSlot!: number;
  stringSlots!: Map<any, any> | null;
  denseBase!: number;
  dense!: any;
  state!: any;

  constructor(keyKind: any, groupIdx: any, aggs: any) {
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
    this.dense = this.keyKind === KeyKind.INT ? new Int32Array(0) : null;
    this.state = this.aggs.map((agg: any) => makeAggState(agg.op, this.capacity));
  }

  get groupCount(): number {
    return this.used;
  }

  _allocSlot(key: any): number {
    if (this.used === this.capacity) {
      this.capacity *= 2;
      this.slotKeys.length = this.capacity;
      this.state = this.state.map((state: any, a: any) => growAggState(this.aggs[a].op, state, this.capacity));
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

  _dictRemap(col: any): any {
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

  _ensureDenseRange(chunk: any, col: any): boolean {
    const size = chunk.size;
    const sv = chunk.selectionVector;
    const data = col.data;
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

  consume(chunk: any): boolean {
    const groupCol = chunk.columns[this.groupIdx];
    if (this.keyKind === KeyKind.DICT) {
      if (!(groupCol instanceof DictionaryColumn)) return false;
    } else if (!groupCol || !groupCol.data) {
      return false;
    }

    const valueCols = new Array(this.aggs.length);
    for (let a = 0; a < this.aggs.length; a++) {
      if (this.aggs[a].colIdx < 0) continue;
      const col = chunk.columns[this.aggs[a].colIdx];
      if (!col || !col.data) return false;
      valueCols[a] = col;
    }

    if (this.keyKind === KeyKind.INT && !this._ensureDenseRange(chunk, groupCol)) return false;
    const remap = this.keyKind === KeyKind.DICT ? this._dictRemap(groupCol) : null;

    const size = chunk.size;
    const sv = chunk.selectionVector;
    const gHasNulls = groupCol.hasNulls;
    const gBitmap = groupCol.nullBitmap;
    const gData = remap ? groupCol.indices : groupCol.data;

    for (let i = 0; i < size; i++) {
      const phys = sv ? sv[i] : i;
      let slot: any;
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
          state.counts[slot]++;
          continue;
        }
        const col = valueCols[a];
        if (col.hasNulls && !testBit(col.nullBitmap, phys)) continue;
        const v = col.data[phys];
        if (agg.op === OP.SUM) {
          state.sums[slot] += v;
          state.has[slot] = 1;
        } else if (agg.op === OP.COUNT) {
          state.counts[slot]++;
        } else if (agg.op === OP.AVG) {
          state.sums[slot] += v;
          state.counts[slot]++;
        } else if (agg.op === OP.MIN) {
          if (!state.has[slot] || v < state.vals[slot]) {
            state.vals[slot] = v;
            state.has[slot] = 1;
          }
        } else if (!state.has[slot] || v > state.vals[slot]) {
          state.vals[slot] = v;
          state.has[slot] = 1;
        }
      }
    }
    return true;
  }

  exportPartials(partitionCount: any): any {
    const mask = partitionCount - 1;
    const partitions: any[] = Array.from({ length: partitionCount }, () => []);
    for (let slot = 0; slot < this.used; slot++) {
      const key = this.slotKeys[slot];
      partitions[(key === null ? 0 : hashValue(key)) & mask].push({
        key,
        groupValues: [key],
        states: this.aggs.map((agg: any, a: any) => exportSlotState(agg.op, this.state[a], slot)),
      });
    }
    return partitions;
  }
}
