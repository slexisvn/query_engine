import { DataChunk } from '../../storage/chunk.js';
import { SetOpType } from '../../planner/logical-plan.js';
import { encodeCompositeKey } from '../composite-key.js';
import type { ColumnValue } from '../../storage/data-type.js';

type RowKey = string;

interface SetOpPolicy {
  keep(rightRemaining: number, alreadyEmitted: number): boolean;
  consumesRight: boolean;
}

const POLICIES: ReadonlyMap<string, SetOpPolicy> = new Map<string, SetOpPolicy>([
  [`${SetOpType.INTERSECT}:all`, { keep: (remaining) => remaining > 0, consumesRight: true }],
  [`${SetOpType.INTERSECT}:distinct`, { keep: (remaining, emitted) => remaining > 0 && emitted === 0, consumesRight: false }],
  [`${SetOpType.EXCEPT}:all`, { keep: (remaining) => remaining === 0, consumesRight: true }],
  [`${SetOpType.EXCEPT}:distinct`, { keep: (remaining, emitted) => remaining === 0 && emitted === 0, consumesRight: false }],
]);

export function setOpPolicy(op: SetOpType, all: boolean): SetOpPolicy {
  const policy = POLICIES.get(`${op}:${all ? 'all' : 'distinct'}`);
  if (!policy) throw new Error(`No set operation policy for ${op}${all ? ' ALL' : ''}`);
  return policy;
}

export class SetOperator {
  policy: SetOpPolicy;
  rightCounts: Map<RowKey, number>;
  emittedCounts: Map<RowKey, number>;
  keyParts: ColumnValue[];

  constructor(op: SetOpType, all: boolean) {
    this.policy = setOpPolicy(op, all);
    this.rightCounts = new Map();
    this.emittedCounts = new Map();
    this.keyParts = [];
  }

  rowKey(chunk: DataChunk, rowIndex: number): RowKey {
    if (this.keyParts.length !== chunk.columns.length) {
      this.keyParts = new Array(chunk.columns.length);
    }
    for (let c = 0; c < chunk.columns.length; c++) {
      this.keyParts[c] = chunk.columns[c].get(rowIndex);
    }
    return encodeCompositeKey(this.keyParts);
  }

  consumeRight(chunk: DataChunk): void {
    for (let i = 0; i < chunk.size; i++) {
      const key = this.rowKey(chunk, chunk.activeRowIndex(i));
      this.rightCounts.set(key, (this.rightCounts.get(key) ?? 0) + 1);
    }
  }

  filterLeft(chunk: DataChunk): DataChunk {
    const selection = new Uint32Array(chunk.size);
    let count = 0;

    for (let i = 0; i < chunk.size; i++) {
      const rowIndex = chunk.activeRowIndex(i);
      const key = this.rowKey(chunk, rowIndex);
      const remaining = this.rightCounts.get(key) ?? 0;
      const emitted = this.emittedCounts.get(key) ?? 0;
      const keep = this.policy.keep(remaining, emitted);

      if (this.policy.consumesRight && remaining > 0) {
        this.rightCounts.set(key, remaining - 1);
      }
      if (!keep) continue;

      this.emittedCounts.set(key, emitted + 1);
      selection[count++] = rowIndex;
    }

    if (count === 0) return new DataChunk(chunk.columns, 0);
    if (count === chunk.size && !chunk.selectionVector) return chunk;

    const result = new DataChunk(chunk.columns, count);
    result.setSelectionVector(selection.slice(0, count), count);
    return result;
  }
}
