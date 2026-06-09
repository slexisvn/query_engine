import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';
import { Config } from '../../config.js';

export const StrategyType = {
  HASH: 'hash',
  RANGE: 'range',
  ROUND_ROBIN: 'round_robin',
};

export class PartitionStrategy {
  get type() {
    throw new Error('Subclass must implement type');
  }

  partitionFor(_key, _partitionCount) {
    throw new Error('Subclass must implement partitionFor()');
  }

  partitionChunk(_chunk, _keyColumnIndex, _partitionCount) {
    throw new Error('Subclass must implement partitionChunk()');
  }
}

export class HashPartitionStrategy extends PartitionStrategy {
  constructor(options = {}) {
    super();
    this._seed = options.seed || 0x9747b28c;
  }

  get type() {
    return StrategyType.HASH;
  }

  partitionFor(key, partitionCount) {
    const hash = murmur3(this._normalizeKey(key), this._seed);
    return hash % partitionCount;
  }

  partitionChunk(chunk, keyColumnIndex, partitionCount) {
    const col = chunk.columns[keyColumnIndex];
    const size = chunk.size;

    const bucketSizes = new Uint32Array(partitionCount);
    const assignments = new Uint32Array(size);

    for (let i = 0; i < size; i++) {
      const rowIdx = chunk.selectionVector ? chunk.selectionVector[i] : i;
      const key = col.get(rowIdx);
      const pid = key === null ? 0 : this.partitionFor(key, partitionCount);
      assignments[i] = pid;
      bucketSizes[pid]++;
    }

    const result = new Map();
    const bucketOffsets = new Uint32Array(partitionCount);
    const bucketIndices = new Array(partitionCount);
    for (let p = 0; p < partitionCount; p++) {
      if (bucketSizes[p] > 0) {
        bucketIndices[p] = new Uint32Array(bucketSizes[p]);
      }
    }

    for (let i = 0; i < size; i++) {
      const pid = assignments[i];
      if (bucketIndices[pid]) {
        bucketIndices[pid][bucketOffsets[pid]++] = i;
      }
    }

    for (let p = 0; p < partitionCount; p++) {
      if (!bucketIndices[p] || bucketSizes[p] === 0) continue;

      const indices = bucketIndices[p];
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

  _normalizeKey(key) {
    if (typeof key === 'bigint') return key.toString();
    if (key === null || key === undefined) return '\0';
    return String(key);
  }
}

export class RangePartitionStrategy extends PartitionStrategy {
  constructor(boundaries) {
    super();
    this._boundaries = boundaries;
  }

  get type() {
    return StrategyType.RANGE;
  }

  get boundaries() {
    return this._boundaries;
  }

  partitionFor(key) {
    if (key === null || key === undefined) return 0;
    return this._binarySearch(key);
  }

  partitionChunk(chunk, keyColumnIndex, _partitionCount) {
    const col = chunk.columns[keyColumnIndex];
    const size = chunk.size;
    const partCount = this._boundaries.length + 1;

    const bucketSizes = new Uint32Array(partCount);
    const assignments = new Uint32Array(size);

    for (let i = 0; i < size; i++) {
      const rowIdx = chunk.selectionVector ? chunk.selectionVector[i] : i;
      const key = col.get(rowIdx);
      const pid = this.partitionFor(key);
      assignments[i] = pid;
      bucketSizes[pid]++;
    }

    const result = new Map();
    const bucketOffsets = new Uint32Array(partCount);
    const bucketIndices = new Array(partCount);
    for (let p = 0; p < partCount; p++) {
      if (bucketSizes[p] > 0) {
        bucketIndices[p] = new Uint32Array(bucketSizes[p]);
      }
    }

    for (let i = 0; i < size; i++) {
      const pid = assignments[i];
      if (bucketIndices[pid]) {
        bucketIndices[pid][bucketOffsets[pid]++] = i;
      }
    }

    for (let p = 0; p < partCount; p++) {
      if (!bucketIndices[p] || bucketSizes[p] === 0) continue;

      const indices = bucketIndices[p];
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

  _binarySearch(key) {
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

  _compare(a, b) {
    if (a === b) return 0;
    if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
}

export class RoundRobinPartitionStrategy extends PartitionStrategy {
  get type() {
    return StrategyType.ROUND_ROBIN;
  }

  partitionFor(rowIndex, partitionCount) {
    return rowIndex % partitionCount;
  }

  partitionChunk(chunk, _keyColumnIndex, partitionCount) {
    const size = chunk.size;
    const bucketSizes = new Uint32Array(partitionCount);

    for (let i = 0; i < size; i++) {
      bucketSizes[i % partitionCount]++;
    }

    const result = new Map();
    const bucketOffsets = new Uint32Array(partitionCount);
    const bucketIndices = new Array(partitionCount);
    for (let p = 0; p < partitionCount; p++) {
      if (bucketSizes[p] > 0) {
        bucketIndices[p] = new Uint32Array(bucketSizes[p]);
      }
    }

    for (let i = 0; i < size; i++) {
      const pid = i % partitionCount;
      bucketIndices[pid][bucketOffsets[pid]++] = i;
    }

    for (let p = 0; p < partitionCount; p++) {
      if (!bucketIndices[p] || bucketSizes[p] === 0) continue;

      const indices = bucketIndices[p];
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

function murmur3(key, seed) {
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
