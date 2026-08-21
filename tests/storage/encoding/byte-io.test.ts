import { describe, it, expect } from 'vitest';
import { ByteReader, ByteWriter, utf8RecordBytes } from '../../../src/storage/encoding/byte-io.js';
import { SabArena } from '../../../src/storage/sab-arena.js';

describe('ByteWriter and ByteReader', () => {
  it('round-trips every scalar width in order', () => {
    const buffer = Buffer.alloc(1 + 2 + 4 + 8);
    const writer = new ByteWriter(buffer);
    writer.u8(200);
    writer.u16(60000);
    writer.u32(4000000000);
    writer.i64(-9007199254740993n);

    const reader = new ByteReader(buffer);
    expect(reader.u8()).toBe(200);
    expect(reader.u16()).toBe(60000);
    expect(reader.u32()).toBe(4000000000);
    expect(reader.i64()).toBe(-9007199254740993n);
    expect(reader.offset).toBe(writer.offset);
  });

  it('round-trips a typed array through a copy that does not alias the buffer', () => {
    const source = Int32Array.from([1, -2, 3]);
    const buffer = Buffer.alloc(source.byteLength);
    new ByteWriter(buffer).bytes(source);

    const restored = new ByteReader(buffer).typed(Int32Array, 3);
    restored[0] = 99;

    expect(Array.from(restored)).toEqual([99, -2, 3]);
    expect(buffer.readInt32LE(0)).toBe(1);
  });

  it('writes only the leading bytes asked for', () => {
    const source = Int32Array.from([7, 8, 9, 10]);
    const buffer = Buffer.alloc(8);
    const writer = new ByteWriter(buffer);
    writer.bytes(source, 8);

    expect(writer.offset).toBe(8);
    expect(Array.from(new ByteReader(buffer).typed(Int32Array, 2))).toEqual([7, 8]);
  });

  it('pads a bitmap out to the requested word count', () => {
    const buffer = Buffer.alloc(12);
    new ByteWriter(buffer).words(Uint32Array.from([0xdeadbeef]), 3);

    const reader = new ByteReader(buffer);
    expect(reader.u32()).toBe(0xdeadbeef);
    expect(reader.u32()).toBe(0);
    expect(reader.u32()).toBe(0);
  });

  it('round-trips multi-byte utf8 and reports its own record size', () => {
    const value = 'naïve — 日本語';
    const buffer = Buffer.alloc(utf8RecordBytes(value));
    const writer = new ByteWriter(buffer);
    writer.utf8(value);

    expect(writer.offset).toBe(utf8RecordBytes(value));
    expect(new ByteReader(buffer).utf8()).toBe(value);
  });

  it('round-trips an empty string', () => {
    const buffer = Buffer.alloc(utf8RecordBytes(''));
    new ByteWriter(buffer).utf8('');
    expect(new ByteReader(buffer).utf8()).toBe('');
  });

  it('reads typed arrays into the allocator it was given', () => {
    const source = Uint16Array.from([1, 2, 3, 4]);
    const buffer = Buffer.alloc(source.byteLength);
    new ByteWriter(buffer).bytes(source);

    const restored = new ByteReader(buffer, 0, new SabArena(1024)).typed(Uint16Array, 4);

    expect(restored.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(Array.from(restored)).toEqual([1, 2, 3, 4]);
  });

  it('starts at the offset it was constructed with', () => {
    const buffer = Buffer.alloc(6);
    new ByteWriter(buffer, 2).u32(12345);

    expect(new ByteReader(buffer, 2).u32()).toBe(12345);
  });
});
