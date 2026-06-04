import { DataType } from './data-type.js';
import { createBitmap, setBit, clearBit, testBit } from '../utils/bitmap.js';

export class DictionaryColumn {
  constructor(capacity = 2048) {
    this.dataType = DataType.VARCHAR;
    this.capacity = capacity;
    this.length = 0;

    this.dictionary = new Map();
    this.reverseDict = [];

    this.indices = new Uint16Array(capacity);
    
    this.nullBitmap = createBitmap(capacity);
    this.hasNulls = false;
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
      if (dictId > 65535) {
        throw new Error('Dictionary capacity exceeded 65535 values per chunk');
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
    const col = new DictionaryColumn(len);

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
    const newIndices = new Uint16Array(newCapacity);
    newIndices.set(this.indices);
    this.indices = newIndices;

    const newBitmap = createBitmap(newCapacity);
    newBitmap.set(this.nullBitmap);
    this.nullBitmap = newBitmap;

    this.capacity = newCapacity;
  }
}
