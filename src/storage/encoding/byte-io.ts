import type { AnyTypedArray, TypedArrayCtor } from '../data-type.js';
import { heapAllocator, type Allocator } from '../sab-arena.js';

export const UINT8_BYTES = 1;
export const UINT16_BYTES = 2;
export const UINT32_BYTES = 4;
export const INT64_BYTES = 8;

const LITTLE_ENDIAN = true;
const SURROGATE_HIGH_MIN = 0xd800;
const SURROGATE_HIGH_MAX = 0xdbff;
const SURROGATE_LOW_MIN = 0xdc00;
const SURROGATE_LOW_MAX = 0xdfff;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += UINT8_BYTES;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= SURROGATE_HIGH_MIN && code <= SURROGATE_HIGH_MAX && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= SURROGATE_LOW_MIN && next <= SURROGATE_LOW_MAX) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function utf8RecordBytes(value: string): number {
  return UINT32_BYTES + utf8ByteLength(value);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];

  let total = 0;
  for (const part of parts) total += part.length;

  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export class ByteWriter {
  buffer: Uint8Array;
  view: DataView;
  offset: number;

  constructor(buffer: Uint8Array, offset = 0) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = offset;
  }

  u8(value: number): void {
    this.view.setUint8(this.offset, value);
    this.offset += UINT8_BYTES;
  }

  u16(value: number): void {
    this.view.setUint16(this.offset, value, LITTLE_ENDIAN);
    this.offset += UINT16_BYTES;
  }

  u32(value: number): void {
    this.view.setUint32(this.offset, value, LITTLE_ENDIAN);
    this.offset += UINT32_BYTES;
  }

  i64(value: bigint): void {
    this.view.setBigInt64(this.offset, value, LITTLE_ENDIAN);
    this.offset += INT64_BYTES;
  }

  bytes(source: ArrayBufferView, byteLength: number = source.byteLength): void {
    this.buffer.set(new Uint8Array(source.buffer, source.byteOffset, byteLength), this.offset);
    this.offset += byteLength;
  }

  words(source: Uint32Array, count: number): void {
    for (let i = 0; i < count; i++) {
      this.u32(i < source.length ? source[i] : 0);
    }
  }

  utf8(value: string): void {
    const { written } = utf8Encoder.encodeInto(value, this.buffer.subarray(this.offset + UINT32_BYTES));
    this.u32(written);
    this.offset += written;
  }
}

export class ByteReader {
  buffer: Uint8Array;
  view: DataView;
  offset: number;
  allocator: Allocator;

  constructor(buffer: Uint8Array, offset = 0, allocator: Allocator = heapAllocator) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = offset;
    this.allocator = allocator;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += UINT8_BYTES;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, LITTLE_ENDIAN);
    this.offset += UINT16_BYTES;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, LITTLE_ENDIAN);
    this.offset += UINT32_BYTES;
    return value;
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.offset, LITTLE_ENDIAN);
    this.offset += INT64_BYTES;
    return value;
  }

  typed<T extends AnyTypedArray>(Ctor: TypedArrayCtor<T>, length: number): T {
    const view = this.allocator.acquire(Ctor, length);
    const byteLength = length * Ctor.BYTES_PER_ELEMENT;
    new Uint8Array(view.buffer, view.byteOffset, byteLength)
      .set(this.buffer.subarray(this.offset, this.offset + byteLength));
    this.offset += byteLength;
    return view;
  }

  utf8(): string {
    const byteLength = this.u32();
    const value = utf8Decoder.decode(this.buffer.subarray(this.offset, this.offset + byteLength));
    this.offset += byteLength;
    return value;
  }
}
