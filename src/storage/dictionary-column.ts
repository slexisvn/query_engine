import { DataType, type ColumnValue } from './data-type.js';
import { bitmapWordCount, setBit, clearBit, testBit } from '../utils/bitmap.js';
import { heapAllocator, type Allocator } from './sab-arena.js';

const DEFAULT_CAPACITY = 2048;
const MAX_DICT_SIZE = 65535;

export interface DictionaryColumnParts {
  indices: Uint16Array;
  reverseDict: string[];
  nullBitmap: Uint32Array;
  length: number;
  hasNulls: boolean;
  allocator?: Allocator;
}

export class DictionaryColumn {
  dataType: DataType;
  capacity: number;
  length: number;
  allocator: Allocator;
  _dictionary: Map<string, number> | null;
  reverseDict: string[];
  indices: Uint16Array;
  nullBitmap: Uint32Array;
  hasNulls: boolean;

  constructor(capacity: number = DEFAULT_CAPACITY, allocator: Allocator = heapAllocator) {
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

  static fromParts({ indices, reverseDict, nullBitmap, length, hasNulls, allocator }: DictionaryColumnParts): DictionaryColumn {
    const col = Object.create(DictionaryColumn.prototype) as DictionaryColumn;
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

  scanView(): DictionaryColumn {
    const view = Object.create(DictionaryColumn.prototype) as DictionaryColumn;
    view.dataType = this.dataType;
    view.capacity = this.capacity;
    view.length = this.length;
    view.allocator = this.allocator;
    view._dictionary = this._dictionary;
    view.reverseDict = this.reverseDict;
    view.indices = this.indices;
    view.nullBitmap = this.nullBitmap;
    view.hasNulls = this.hasNulls;
    return view;
  }

  get dictionary(): Map<string, number> {
    if (this._dictionary === null) {
      this._dictionary = new Map(this.reverseDict.map((value, id) => [value, id]));
    }
    return this._dictionary;
  }

  set dictionary(map: Map<string, number>) {
    this._dictionary = map;
  }

  get(index: number): ColumnValue {
    if (this.hasNulls && !testBit(this.nullBitmap, index)) {
      return null;
    }
    const dictId = this.indices[index];
    return this.reverseDict[dictId];
  }

  set(index: number, value: ColumnValue): void {
    if (value === null || value === undefined) {
      this._setNull(index);
      return;
    }

    setBit(this.nullBitmap, index);

    const key = value as string;
    let dictId = this.dictionary.get(key);
    if (dictId === undefined) {
      dictId = this.reverseDict.length;
      if (dictId > MAX_DICT_SIZE) {
        throw new Error(`Dictionary capacity exceeded ${MAX_DICT_SIZE} values per chunk`);
      }
      this.dictionary.set(key, dictId);
      this.reverseDict.push(key);
    }

    this.indices[index] = dictId;

    if (index >= this.length) {
      this.length = index + 1;
    }
  }

  append(value: ColumnValue): void {
    if (this.length >= this.capacity) {
      this._grow();
    }
    this.set(this.length, value);
  }

  appendBatch(values: ColumnValue[]): void {
    for (let i = 0; i < values.length; i++) {
      this.append(values[i]);
    }
  }

  isNull(index: number): boolean {
    return this.hasNulls && !testBit(this.nullBitmap, index);
  }

  slice(start: number, end: number): DictionaryColumn {
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

  _setNull(index: number): void {
    this.hasNulls = true;
    clearBit(this.nullBitmap, index);
    if (index >= this.length) {
      this.length = index + 1;
    }
  }

  _grow(): void {
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
