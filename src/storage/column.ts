import { DataType, getDecimalScaleNumber, isFixedWidth, typedArrayCtorFor, type AnyTypedArray, type ColumnValue } from './data-type.js';
import { bitmapWordCount, setBit, clearBit, testBit } from '../utils/bitmap.js';
import { heapAllocator, type Allocator } from './sab-arena.js';
import type { EncodedVector } from './encoding/encoding-types.js';

const DEFAULT_CAPACITY = 2048;
const STRING_INITIAL_BYTES = 4096;

export interface ColumnParts {
  dataType: DataType;
  data?: AnyTypedArray;
  offsets?: Uint32Array;
  stringBytes?: Uint8Array;
  stringBytesUsed?: number;
  nullBitmap: Uint32Array;
  length: number;
  hasNulls: boolean;
  allocator?: Allocator;
}

export interface EncodedColumnParts {
  dataType: DataType;
  encoded: EncodedVector;
  nullBitmap: Uint32Array;
  length: number;
  hasNulls: boolean;
  allocator?: Allocator;
}

export class Column {
  dataType: DataType;
  capacity: number;
  length: number;
  allocator: Allocator;
  encoded: EncodedVector | null;
  _data?: AnyTypedArray;
  offsets?: Uint32Array;
  stringBytes?: Uint8Array;
  stringBytesUsed?: number;
  nullBitmap: Uint32Array;
  hasNulls: boolean;

  constructor(dataType: DataType, capacity: number = DEFAULT_CAPACITY, allocator: Allocator = heapAllocator) {
    this.dataType = dataType;
    this.capacity = capacity;
    this.length = 0;
    this.allocator = allocator;
    this.encoded = null;

    if (isFixedWidth(dataType)) {
      this._data = allocator.acquire(typedArrayCtorFor(dataType), capacity);
    } else if (dataType === DataType.VARCHAR) {
      this.offsets = allocator.acquire(Uint32Array, capacity + 1);
      this.stringBytes = allocator.acquire(Uint8Array, STRING_INITIAL_BYTES);
      this.stringBytesUsed = 0;
    } else {
      throw new Error(`Unsupported column data type: ${dataType}`);
    }

    this.nullBitmap = allocator.acquire(Uint32Array, bitmapWordCount(capacity));
    this.hasNulls = false;
  }

  static fromParts({ dataType, data, offsets, stringBytes, stringBytesUsed, nullBitmap, length, hasNulls, allocator }: ColumnParts): Column {
    const col = Object.create(Column.prototype) as Column;
    col.dataType = dataType;
    col.capacity = length;
    col.length = length;
    col.allocator = allocator || heapAllocator;
    col.encoded = null;
    if (data !== undefined) col._data = data;
    if (offsets !== undefined) {
      col.offsets = offsets;
      col.stringBytes = stringBytes;
      col.stringBytesUsed = stringBytesUsed;
    }
    col.nullBitmap = nullBitmap;
    col.hasNulls = hasNulls;
    return col;
  }

  static fromEncoded({ dataType, encoded, nullBitmap, length, hasNulls, allocator }: EncodedColumnParts): Column {
    const col = Object.create(Column.prototype) as Column;
    col.dataType = dataType;
    col.capacity = length;
    col.length = length;
    col.allocator = allocator || heapAllocator;
    col.encoded = encoded;
    col.nullBitmap = nullBitmap;
    col.hasNulls = hasNulls;
    return col;
  }

  get data(): AnyTypedArray | undefined {
    if (this.encoded !== null) {
      this._data = this.encoded.decode();
      this.encoded = null;
    }
    return this._data;
  }

  set data(value: AnyTypedArray | undefined) {
    this.encoded = null;
    this._data = value;
  }

  scanView(): Column {
    const view = Object.create(Column.prototype) as Column;
    view.dataType = this.dataType;
    view.capacity = this.capacity;
    view.length = this.length;
    view.allocator = this.allocator;
    view.encoded = this.encoded;
    view._data = this._data;
    view.offsets = this.offsets;
    view.stringBytes = this.stringBytes;
    view.stringBytesUsed = this.stringBytesUsed;
    view.nullBitmap = this.nullBitmap;
    view.hasNulls = this.hasNulls;
    return view;
  }

  get(index: number): ColumnValue {
    if (this.hasNulls && !testBit(this.nullBitmap, index)) {
      return null;
    }

    if (this.encoded !== null) {
      return this.encoded.valueAt(index);
    }

    if (this.dataType === DataType.VARCHAR) {
      return this._getString(index);
    }

    const val = this._data![index];
    if (this.dataType === DataType.BOOLEAN) {
      return val !== 0;
    }
    if (this.dataType === DataType.DECIMAL) {
      return Number(val) / getDecimalScaleNumber();
    }
    return val;
  }

  set(index: number, value: ColumnValue): void {
    if (value === null || value === undefined) {
      this._setNull(index);
      return;
    }

    setBit(this.nullBitmap, index);

    if (this.dataType === DataType.VARCHAR) {
      this._setString(index, value as string);
    } else if (this.dataType === DataType.BOOLEAN) {
      (this.data! as Uint8Array)[index] = value ? 1 : 0;
    } else if (this.dataType === DataType.DECIMAL) {
      (this.data! as BigInt64Array)[index] = typeof value === 'bigint'
        ? value
        : BigInt(Math.round(Number(value) * getDecimalScaleNumber()));
    } else {
      const target = this.data!;
      if (target instanceof BigInt64Array) {
        target[index] = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
      } else {
        (target as Float64Array)[index] = typeof value === 'bigint' ? Number(value) : (value as number);
      }
    }

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

  slice(start: number, end: number): Column {
    const len = end - start;
    const col = new Column(this.dataType, len, this.allocator);

    if (this.dataType === DataType.VARCHAR || this.encoded !== null) {
      for (let i = 0; i < len; i++) {
        col.set(i, this.get(start + i));
      }
    } else {
      if (this._data) {
        const srcSlice = this._data.subarray(start, end);
        (col.data! as Float64Array).set(srcSlice as Float64Array);
      }
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

  _setNull(index: number): void {
    this.hasNulls = true;
    clearBit(this.nullBitmap, index);
    if (this.dataType === DataType.VARCHAR) {
      this.offsets![index + 1] = this.offsets![index];
    }
    if (index >= this.length) {
      this.length = index + 1;
    }
  }

  _getString(index: number): string {
    const start = this.offsets![index];
    const end = this.offsets![index + 1];
    if (start === end) return '';
    const bytes = this.stringBytes!.subarray(start, end);
    return new TextDecoder().decode(bytes);
  }

  _setString(index: number, value: string): void {
    const encoded = new TextEncoder().encode(value);
    while (this.stringBytesUsed! + encoded.length > this.stringBytes!.length) {
      this._growStringBuffer();
    }

    this.offsets![index] = this.stringBytesUsed!;
    this.stringBytes!.set(encoded, this.stringBytesUsed!);
    this.stringBytesUsed! += encoded.length;
    this.offsets![index + 1] = this.stringBytesUsed!;
  }

  _grow(): void {
    const newCapacity = this.capacity * 2;

    if (isFixedWidth(this.dataType)) {
      const newData = this.allocator.acquire(typedArrayCtorFor(this.dataType), newCapacity);
      (newData as Float64Array).set(this.data! as Float64Array);
      this.data = newData;
    } else {
      const newOffsets = this.allocator.acquire(Uint32Array, newCapacity + 1);
      newOffsets.set(this.offsets!);
      this.offsets = newOffsets;
    }

    const newBitmap = this.allocator.acquire(Uint32Array, bitmapWordCount(newCapacity));
    newBitmap.set(this.nullBitmap);
    this.nullBitmap = newBitmap;

    this.capacity = newCapacity;
  }

  _growStringBuffer(): void {
    const newBuffer = this.allocator.acquire(Uint8Array, this.stringBytes!.length * 2);
    newBuffer.set(this.stringBytes!);
    this.stringBytes = newBuffer;
  }
}
