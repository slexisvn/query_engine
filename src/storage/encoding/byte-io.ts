import type { AnyTypedArray, TypedArrayCtor } from '../data-type.js';
import { heapAllocator, type Allocator } from '../sab-arena.js';

export const UINT8_BYTES = 1;
export const UINT16_BYTES = 2;
export const UINT32_BYTES = 4;
export const INT64_BYTES = 8;

export function utf8RecordBytes(value: string): number {
  return UINT32_BYTES + Buffer.byteLength(value, 'utf8');
}

export class ByteWriter {
  buffer: Buffer;
  offset: number;

  constructor(buffer: Buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }

  u8(value: number): void {
    this.buffer.writeUInt8(value, this.offset);
    this.offset += UINT8_BYTES;
  }

  u16(value: number): void {
    this.buffer.writeUInt16LE(value, this.offset);
    this.offset += UINT16_BYTES;
  }

  u32(value: number): void {
    this.buffer.writeUInt32LE(value, this.offset);
    this.offset += UINT32_BYTES;
  }

  i64(value: bigint): void {
    this.buffer.writeBigInt64LE(value, this.offset);
    this.offset += INT64_BYTES;
  }

  bytes(source: ArrayBufferView, byteLength: number = source.byteLength): void {
    Buffer.from(source.buffer, source.byteOffset, byteLength).copy(this.buffer, this.offset);
    this.offset += byteLength;
  }

  words(source: Uint32Array, count: number): void {
    for (let i = 0; i < count; i++) {
      this.u32(i < source.length ? source[i] : 0);
    }
  }

  utf8(value: string): void {
    const byteLength = Buffer.byteLength(value, 'utf8');
    this.u32(byteLength);
    this.buffer.write(value, this.offset, 'utf8');
    this.offset += byteLength;
  }
}

export class ByteReader {
  buffer: Buffer;
  offset: number;
  allocator: Allocator;

  constructor(buffer: Buffer, offset = 0, allocator: Allocator = heapAllocator) {
    this.buffer = buffer;
    this.offset = offset;
    this.allocator = allocator;
  }

  u8(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += UINT8_BYTES;
    return value;
  }

  u16(): number {
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += UINT16_BYTES;
    return value;
  }

  u32(): number {
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += UINT32_BYTES;
    return value;
  }

  i64(): bigint {
    const value = this.buffer.readBigInt64LE(this.offset);
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
    const value = this.buffer.toString('utf8', this.offset, this.offset + byteLength);
    this.offset += byteLength;
    return value;
  }
}
