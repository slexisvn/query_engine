import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';
import type { ColumnValue } from '../../storage/data-type.js';
import { Config } from '../../config.js';
import { keyIdentityText } from '../../execution/hash-table.js';

const NULL_PARTITION = 0;

export const StrategyType = {
  HASH: 'hash',
  RANGE: 'range',
  ROUND_ROBIN: 'round_robin',
};

export type StrategyTypeValue = (typeof StrategyType)[keyof typeof StrategyType];

export interface HashPartitionOptions {
  seed?: number;
}

export type PartitionChunkResult = Map<number, DataChunk>;

export class PartitionStrategy {
  get type(): StrategyTypeValue {
    throw new Error('Subclass must implement type');
  }

  partitionFor(_key: ColumnValue, _partitionCount: number): number {
    throw new Error('Subclass must implement partitionFor()');
  }

  partitionChunk(_chunk: DataChunk, _keyColumnIndex: number, _partitionCount: number): PartitionChunkResult {
    throw new Error('Subclass must implement partitionChunk()');
  }

  protected _scatterByAssignments(
    chunk: DataChunk,
    assignments: Uint32Array,
    partCount: number
  ): PartitionChunkResult {
    const size = chunk.size;
    const bucketSizes = new Uint32Array(partCount);
    for (let i = 0; i < size; i++) {
      bucketSizes[assignments[i]]++;
    }

    const result = new Map<number, DataChunk>();
    const bucketOffsets = new Uint32Array(partCount);
    const bucketIndices = new Array<Uint32Array | undefined>(partCount);
    for (let p = 0; p < partCount; p++) {
      if (bucketSizes[p] > 0) {
        bucketIndices[p] = new Uint32Array(bucketSizes[p]);
      }
    }

    for (let i = 0; i < size; i++) {
      const pid = assignments[i];
      if (bucketIndices[pid]) {
        bucketIndices[pid]![bucketOffsets[pid]++] = i;
      }
    }

    for (let p = 0; p < partCount; p++) {
      if (!bucketIndices[p] || bucketSizes[p] === 0) continue;

      const indices = bucketIndices[p]!;
      const partCols = chunk.columns.map(srcCol => {
        const newCol = new Column(srcCol.dataType, bucketSizes[p]);
        for (let j = 0; j < bucketSizes[p]; j++) {
          const srcRow = chunk.selectionVector ? chunk.selectionVector[indices[j]] : indices[j];
          newCol.set(j, srcCol.get(srcRow));
        }
        newCol.length = bucketSizes[p];
        return newCol;
      });

      result.set(p, new DataChunk(partCols, bucketSizes[p]));
    }

    return result;
  }
}

export class HashPartitionStrategy extends PartitionStrategy {
  _seed: number;
  _keyParts: ColumnValue[];

  constructor(options: HashPartitionOptions = {}) {
    super();
    this._seed = options.seed || 0x9747b28c;
    this._keyParts = [null];
  }

  override get type(): StrategyTypeValue {
    return StrategyType.HASH;
  }

  override partitionFor(key: ColumnValue, partitionCount: number): number {
    if (key === null || key === undefined) return NULL_PARTITION;
    const hash = murmur3(this._normalizeKey(key), this._seed);
    return hash % partitionCount;
  }

  override partitionChunk(chunk: DataChunk, keyColumnIndex: number, partitionCount: number): PartitionChunkResult {
    const col = chunk.columns[keyColumnIndex];
    const size = chunk.size;

    const assignments = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      const rowIdx = chunk.selectionVector ? chunk.selectionVector[i] : i;
      const key = col.get(rowIdx);
      assignments[i] = this.partitionFor(key, partitionCount);
    }

    return this._scatterByAssignments(chunk, assignments, partitionCount);
  }

  _normalizeKey(key: ColumnValue): string {
    this._keyParts[0] = key;
    return keyIdentityText(this._keyParts, 1);
  }
}

export class RangePartitionStrategy extends PartitionStrategy {
  _boundaries: ColumnValue[];

  constructor(boundaries: ColumnValue[]) {
    super();
    this._boundaries = boundaries;
  }

  override get type(): StrategyTypeValue {
    return StrategyType.RANGE;
  }

  get boundaries(): ColumnValue[] {
    return this._boundaries;
  }

  override partitionFor(key: ColumnValue): number {
    if (key === null || key === undefined) return NULL_PARTITION;
    return this._binarySearch(key);
  }

  override partitionChunk(chunk: DataChunk, keyColumnIndex: number, _partitionCount: number): PartitionChunkResult {
    const col = chunk.columns[keyColumnIndex];
    const size = chunk.size;
    const partCount = this._boundaries.length + 1;

    const assignments = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      const rowIdx = chunk.selectionVector ? chunk.selectionVector[i] : i;
      const key = col.get(rowIdx);
      assignments[i] = this.partitionFor(key);
    }

    return this._scatterByAssignments(chunk, assignments, partCount);
  }

  _binarySearch(key: ColumnValue): number {
    let lo = 0;
    let hi = this._boundaries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this._compare(this._boundaries[mid], key) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  _compare(a: ColumnValue, b: ColumnValue): number {
    if (a === b) return 0;
    if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
}

export class RoundRobinPartitionStrategy extends PartitionStrategy {
  override get type(): StrategyTypeValue {
    return StrategyType.ROUND_ROBIN;
  }

  override partitionFor(rowIndex: ColumnValue, partitionCount: number): number {
    return (rowIndex as number) % partitionCount;
  }

  override partitionChunk(chunk: DataChunk, _keyColumnIndex: number, partitionCount: number): PartitionChunkResult {
    const size = chunk.size;

    const assignments = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      assignments[i] = i % partitionCount;
    }

    return this._scatterByAssignments(chunk, assignments, partitionCount);
  }
}

function murmur3(key: ColumnValue, seed: number): number {
  const str = typeof key === 'string' ? key : String(key);
  let h = seed >>> 0;
  const len = str.length;

  let i = 0;
  while (i + 4 <= len) {
    let k = (str.charCodeAt(i) & 0xff)
      | ((str.charCodeAt(i + 1) & 0xff) << 8)
      | ((str.charCodeAt(i + 2) & 0xff) << 16)
      | ((str.charCodeAt(i + 3) & 0xff) << 24);

    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);

    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = Math.imul(h, 5) + 0xe6546b64;
    i += 4;
  }

  let k = 0;
  switch (len - i) {
    case 3: k ^= (str.charCodeAt(i + 2) & 0xff) << 16;
    case 2: k ^= (str.charCodeAt(i + 1) & 0xff) << 8;
    case 1:
      k ^= str.charCodeAt(i) & 0xff;
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h ^= k;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;

  return (h >>> 0);
}

export { murmur3 };
