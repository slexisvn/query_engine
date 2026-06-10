import { DataType } from './data-type.js';
import { bitmapWordCount, setBit, clearBit, testBit } from '../utils/bitmap.js';
import { heapAllocator } from './sab-arena.js';

const DEFAULT_CAPACITY = 2048;
const MAX_DICT_SIZE = 65535;

export class DictionaryColumn {
  constructor(capacity = DEFAULT_CAPACITY, allocator = heapAllocator) {
    this.dataType = DataType.VARCHAR;
    this.capacity = capacity;
    this.length = 0;
    this.allocator = allocator;

    this._dictionary = new Map();
    this.reverseDict = [];

    this.indices = allocator.acquire(Uint16Array, capacity);

    this.nullBitmap = allocator.acquire(Uint32Array, bitmapWordCount(capacity));
    this.hasNulls = false;
  }

  static fromParts({ indices, reverseDict, nullBitmap, length, hasNulls, allocator }) {
    const col = Object.create(DictionaryColumn.prototype);
    col.dataType = DataType.VARCHAR;
    col.capacity = length;
    col.length = length;
    col.allocator = allocator || heapAllocator;
    col._dictionary = null;
    col.reverseDict = reverseDict;
    col.indices = indices;
    col.nullBitmap = nullBitmap;
    col.hasNulls = hasNulls;
    return col;
  }

  get dictionary() {
    if (this._dictionary === null) {
      this._dictionary = new Map(this.reverseDict.map((value, id) => [value, id]));
    }
    return this._dictionary;
  }

  set dictionary(map) {
    this._dictionary = map;
  }

  get(index) {
    if (this.hasNulls && !testBit(this.nullBitmap, index)) {
      return null;
    }
    const dictId = this.indices[index];
    return this.reverseDict[dictId];
  }

  set(index, value) {
    if (value === null || value === undefined) {
      this._setNull(index);
      return;
    }

    setBit(this.nullBitmap, index);

    let dictId = this.dictionary.get(value);
    if (dictId === undefined) {
      dictId = this.reverseDict.length;
      if (dictId > MAX_DICT_SIZE) {
        throw new Error(`Dictionary capacity exceeded ${MAX_DICT_SIZE} values per chunk`);
      }
      this.dictionary.set(value, dictId);
      this.reverseDict.push(value);
    }

    this.indices[index] = dictId;

    if (index >= this.length) {
      this.length = index + 1;
    }
  }

  append(value) {
    if (this.length >= this.capacity) {
      this._grow();
    }
    this.set(this.length, value);
  }

  appendBatch(values) {
    for (let i = 0; i < values.length; i++) {
      this.append(values[i]);
    }
  }

  isNull(index) {
    return this.hasNulls && !testBit(this.nullBitmap, index);
  }

  slice(start, end) {
    const len = end - start;
    const col = new DictionaryColumn(len, this.allocator);

    col.dictionary = this.dictionary;
    col.reverseDict = this.reverseDict;

    const srcSlice = this.indices.subarray(start, end);
    col.indices.set(srcSlice);

    for (let i = 0; i < len; i++) {
      if (testBit(this.nullBitmap, start + i)) {
        setBit(col.nullBitmap, i);
      }
    }

    col.length = len;
    col.hasNulls = this.hasNulls;
    return col;
  }

  _setNull(index) {
    this.hasNulls = true;
    clearBit(this.nullBitmap, index);
    if (index >= this.length) {
      this.length = index + 1;
    }
  }

  _grow() {
    const newCapacity = this.capacity * 2;
    const newIndices = this.allocator.acquire(Uint16Array, newCapacity);
    newIndices.set(this.indices);
    this.indices = newIndices;

    const newBitmap = this.allocator.acquire(Uint32Array, bitmapWordCount(newCapacity));
    newBitmap.set(this.nullBitmap);
    this.nullBitmap = newBitmap;

    this.capacity = newCapacity;
  }
}
