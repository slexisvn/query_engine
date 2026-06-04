import { DataType, isFixedWidth, typedArrayFor } from './data-type.js';
import { createBitmap, setBit, clearBit, testBit } from '../utils/bitmap.js';

const DEFAULT_CAPACITY = 2048;
const STRING_INITIAL_BYTES = 4096;

export class Column {
  constructor(dataType, capacity = DEFAULT_CAPACITY) {
    this.dataType = dataType;
    this.capacity = capacity;
    this.length = 0;

    if (isFixedWidth(dataType)) {
      this.data = typedArrayFor(dataType, capacity);
    } else {
      this.offsets = new Uint32Array(capacity + 1);
      this.stringBytes = new Uint8Array(STRING_INITIAL_BYTES);
      this.stringBytesUsed = 0;
    }

    this.nullBitmap = createBitmap(capacity);
    this.hasNulls = false;
  }

  get(index) {
    if (this.hasNulls && !testBit(this.nullBitmap, index)) {
      return null;
    }

    if (this.dataType === DataType.VARCHAR) {
      return this._getString(index);
    }

    const val = this.data[index];
    if (this.dataType === DataType.BOOLEAN) {
      return val !== 0;
    }
    return val;
  }

  set(index, value) {
    if (value === null || value === undefined) {
      this._setNull(index);
      return;
    }

    setBit(this.nullBitmap, index);

    if (this.dataType === DataType.VARCHAR) {
      this._setString(index, value);
    } else if (this.dataType === DataType.BOOLEAN) {
      this.data[index] = value ? 1 : 0;
    } else {
      this.data[index] = value;
    }

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
    const col = new Column(this.dataType, len);

    if (this.dataType === DataType.VARCHAR) {
      for (let i = 0; i < len; i++) {
        col.set(i, this.get(start + i));
      }
    } else {
      if (this.data) {
        const srcSlice = this.data.subarray(start, end);
        col.data.set(srcSlice);
      }
      const bitmapWords = Math.ceil(len / 32);
      for (let i = 0; i < len; i++) {
        if (testBit(this.nullBitmap, start + i)) {
          setBit(col.nullBitmap, i);
        }
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

  _getString(index) {
    const start = this.offsets[index];
    const end = this.offsets[index + 1];
    if (start === end) return '';
    const bytes = this.stringBytes.subarray(start, end);
    return new TextDecoder().decode(bytes);
  }

  _setString(index, value) {
    const encoded = new TextEncoder().encode(value);
    while (this.stringBytesUsed + encoded.length > this.stringBytes.length) {
      this._growStringBuffer();
    }

    this.offsets[index] = this.stringBytesUsed;
    this.stringBytes.set(encoded, this.stringBytesUsed);
    this.stringBytesUsed += encoded.length;
    this.offsets[index + 1] = this.stringBytesUsed;
  }

  _grow() {
    const newCapacity = this.capacity * 2;

    if (isFixedWidth(this.dataType)) {
      const newData = typedArrayFor(this.dataType, newCapacity);
      newData.set(this.data);
      this.data = newData;
    } else {
      const newOffsets = new Uint32Array(newCapacity + 1);
      newOffsets.set(this.offsets);
      this.offsets = newOffsets;
    }

    const newBitmap = createBitmap(newCapacity);
    newBitmap.set(this.nullBitmap);
    this.nullBitmap = newBitmap;

    this.capacity = newCapacity;
  }

  _growStringBuffer() {
    const newBuffer = new Uint8Array(this.stringBytes.length * 2);
    newBuffer.set(this.stringBytes);
    this.stringBytes = newBuffer;
  }
}
