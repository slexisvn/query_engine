import { Column } from './column.js';
import { DictionaryColumn } from './dictionary-column.js';
import { DataChunk, type AnyColumn } from './chunk.js';
import { DataType, isFixedWidth, byteWidthFor, typedArrayCtorFor, type AnyTypedArray } from './data-type.js';
import { heapAllocator, type Allocator } from './sab-arena.js';
import { bitmapWordCount } from '../utils/bitmap.js';

const COLUMN_KIND_FLAT = 0;
const COLUMN_KIND_DICTIONARY = 1;

const DATA_TYPE_TO_ID: Record<DataType, number> = {
  [DataType.BOOLEAN]: 0,
  [DataType.INT32]: 1,
  [DataType.INT64]: 2,
  [DataType.FLOAT64]: 3,
  [DataType.DECIMAL]: 4,
  [DataType.VARCHAR]: 5,
  [DataType.DATE]: 6,
  [DataType.TIMESTAMP]: 7,
};

const ID_TO_DATA_TYPE = Object.fromEntries(
  Object.entries(DATA_TYPE_TO_ID).map(([k, v]) => [v, k])
) as Record<number, DataType>;

export class ChunkSerializer {
  static serialize(source: DataChunk): Buffer {
    const chunk = source.selectionVector ? source.flatten() : source;
    const size = computeSize(chunk);
    const buf = Buffer.allocUnsafe(size);
    let offset = 0;

    buf.writeUInt32LE(chunk.size, offset); offset += 4;
    buf.writeUInt16LE(chunk.columns.length, offset); offset += 2;

    for (const col of chunk.columns) {
      const isDictionary = col instanceof DictionaryColumn;
      buf.writeUInt8(isDictionary ? COLUMN_KIND_DICTIONARY : COLUMN_KIND_FLAT, offset); offset += 1;
      buf.writeUInt8(DATA_TYPE_TO_ID[col.dataType], offset); offset += 1;
      buf.writeUInt32LE(col.length, offset); offset += 4;
      buf.writeUInt8(col.hasNulls ? 1 : 0, offset); offset += 1;

      if (col.hasNulls) {
        const wordCount = bitmapWordCount(col.length);
        buf.writeUInt32LE(wordCount, offset); offset += 4;
        const bitmapBytes = wordCount * 4;
        Buffer.from(col.nullBitmap.buffer, col.nullBitmap.byteOffset, bitmapBytes).copy(buf, offset);
        offset += bitmapBytes;
      }

      if (isDictionary) {
        const dc = col as DictionaryColumn;
        const indicesBytes = dc.length * 2;
        Buffer.from(dc.indices.buffer, dc.indices.byteOffset, indicesBytes).copy(buf, offset);
        offset += indicesBytes;

        const dictSize = dc.reverseDict.length;
        buf.writeUInt32LE(dictSize, offset); offset += 4;
        for (let i = 0; i < dictSize; i++) {
          const encoded = Buffer.from(dc.reverseDict[i], 'utf8');
          buf.writeUInt32LE(encoded.length, offset); offset += 4;
          encoded.copy(buf, offset);
          offset += encoded.length;
        }
      } else if (isFixedWidth(col.dataType)) {
        const fc = col as Column;
        const bw = byteWidthFor(fc.dataType);
        const dataBytes = fc.length * bw;
        Buffer.from(fc.data!.buffer, fc.data!.byteOffset, dataBytes).copy(buf, offset);
        offset += dataBytes;
      } else {
        const fc = col as Column;
        buf.writeUInt32LE(fc.stringBytesUsed!, offset); offset += 4;
        const offsetsBytes = (fc.length + 1) * 4;
        Buffer.from(fc.offsets!.buffer, fc.offsets!.byteOffset, offsetsBytes).copy(buf, offset);
        offset += offsetsBytes;
        Buffer.from(fc.stringBytes!.buffer, fc.stringBytes!.byteOffset, fc.stringBytesUsed!).copy(buf, offset);
        offset += fc.stringBytesUsed!;
      }
    }

    return buf;
  }

  static deserialize(buffer: Buffer, allocator: Allocator = heapAllocator): DataChunk {
    let offset = 0;

    const size = buffer.readUInt32LE(offset); offset += 4;
    const columnCount = buffer.readUInt16LE(offset); offset += 2;

    const columns: AnyColumn[] = [];
    for (let c = 0; c < columnCount; c++) {
      const columnKind = buffer.readUInt8(offset); offset += 1;
      const dataTypeId = buffer.readUInt8(offset); offset += 1;
      const length = buffer.readUInt32LE(offset); offset += 4;
      const hasNulls = buffer.readUInt8(offset) !== 0; offset += 1;
      const dataType = ID_TO_DATA_TYPE[dataTypeId];

      let nullBitmap: Uint32Array;
      if (hasNulls) {
        const storedWords = buffer.readUInt32LE(offset); offset += 4;
        nullBitmap = allocator.acquire(Uint32Array, storedWords);
        offset = copyBytesInto(buffer, offset, nullBitmap, storedWords * 4);
      } else {
        nullBitmap = allocator.acquire(Uint32Array, bitmapWordCount(Math.max(length, 1)));
      }

      if (columnKind === COLUMN_KIND_DICTIONARY) {
        const indices = allocator.acquire(Uint16Array, length);
        offset = copyBytesInto(buffer, offset, indices, length * 2);

        const dictSize = buffer.readUInt32LE(offset); offset += 4;
        const reverseDict: string[] = [];
        for (let d = 0; d < dictSize; d++) {
          const strLen = buffer.readUInt32LE(offset); offset += 4;
          reverseDict.push(buffer.toString('utf8', offset, offset + strLen));
          offset += strLen;
        }
        columns.push(DictionaryColumn.fromParts({ indices, reverseDict, nullBitmap, length, hasNulls, allocator }));
      } else if (isFixedWidth(dataType)) {
        const data = allocator.acquire(typedArrayCtorFor(dataType), length);
        offset = copyBytesInto(buffer, offset, data, length * byteWidthFor(dataType));
        columns.push(Column.fromParts({ dataType, data, nullBitmap, length, hasNulls, allocator }));
      } else {
        const stringBytesUsed = buffer.readUInt32LE(offset); offset += 4;
        const offsets = allocator.acquire(Uint32Array, length + 1);
        offset = copyBytesInto(buffer, offset, offsets, (length + 1) * 4);
        const stringBytes = allocator.acquire(Uint8Array, stringBytesUsed);
        offset = copyBytesInto(buffer, offset, stringBytes, stringBytesUsed);
        columns.push(Column.fromParts({ dataType, offsets, stringBytes, stringBytesUsed, nullBitmap, length, hasNulls, allocator }));
      }
    }

    return new DataChunk(columns, size);
  }
}

function copyBytesInto(buffer: Buffer, offset: number, view: AnyTypedArray, byteLength: number): number {
  const dest = new Uint8Array(view.buffer, view.byteOffset, byteLength);
  dest.set(buffer.subarray(offset, offset + byteLength));
  return offset + byteLength;
}

function computeSize(chunk: DataChunk): number {
  let total = 4 + 2;

  for (const col of chunk.columns) {
    const isDictionary = col instanceof DictionaryColumn;
    total += 1 + 1 + 4 + 1;

    if (col.hasNulls) {
      total += 4 + bitmapWordCount(col.length) * 4;
    }

    if (isDictionary) {
      const dc = col as DictionaryColumn;
      total += dc.length * 2;
      total += 4;
      for (let i = 0; i < dc.reverseDict.length; i++) {
        total += 4 + Buffer.byteLength(dc.reverseDict[i], 'utf8');
      }
    } else if (isFixedWidth(col.dataType)) {
      total += col.length * byteWidthFor(col.dataType);
    } else {
      const fc = col as Column;
      total += 4 + (fc.length + 1) * 4 + fc.stringBytesUsed!;
    }
  }

  return total;
}
