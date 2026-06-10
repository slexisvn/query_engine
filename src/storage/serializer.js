import { Column } from './column.js';
import { DictionaryColumn } from './dictionary-column.js';
import { DataChunk } from './chunk.js';
import { DataType, isFixedWidth, byteWidthFor, typedArrayCtorFor } from './data-type.js';
import { heapAllocator } from './sab-arena.js';
import { bitmapWordCount } from '../utils/bitmap.js';

const COLUMN_KIND_FLAT = 0;
const COLUMN_KIND_DICTIONARY = 1;

const DATA_TYPE_TO_ID = {
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
);

export class ChunkSerializer {
  static serialize(chunk) {
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
        const bitmapWordCount = Math.ceil(col.length / 32);
        buf.writeUInt32LE(bitmapWordCount, offset); offset += 4;
        const bitmapBytes = bitmapWordCount * 4;
        Buffer.from(col.nullBitmap.buffer, col.nullBitmap.byteOffset, bitmapBytes).copy(buf, offset);
        offset += bitmapBytes;
      }

      if (isDictionary) {
        const indicesBytes = col.length * 2;
        Buffer.from(col.indices.buffer, col.indices.byteOffset, indicesBytes).copy(buf, offset);
        offset += indicesBytes;

        const dictSize = col.reverseDict.length;
        buf.writeUInt32LE(dictSize, offset); offset += 4;
        for (let i = 0; i < dictSize; i++) {
          const encoded = Buffer.from(col.reverseDict[i], 'utf8');
          buf.writeUInt32LE(encoded.length, offset); offset += 4;
          encoded.copy(buf, offset);
          offset += encoded.length;
        }
      } else if (isFixedWidth(col.dataType)) {
        const bw = byteWidthFor(col.dataType);
        const dataBytes = col.length * bw;
        Buffer.from(col.data.buffer, col.data.byteOffset, dataBytes).copy(buf, offset);
        offset += dataBytes;
      } else {
        buf.writeUInt32LE(col.stringBytesUsed, offset); offset += 4;
        const offsetsBytes = (col.length + 1) * 4;
        Buffer.from(col.offsets.buffer, col.offsets.byteOffset, offsetsBytes).copy(buf, offset);
        offset += offsetsBytes;
        Buffer.from(col.stringBytes.buffer, col.stringBytes.byteOffset, col.stringBytesUsed).copy(buf, offset);
        offset += col.stringBytesUsed;
      }
    }

    return buf;
  }

  static deserialize(buffer, allocator = heapAllocator) {
    let offset = 0;

    const size = buffer.readUInt32LE(offset); offset += 4;
    const columnCount = buffer.readUInt16LE(offset); offset += 2;

    const columns = [];
    for (let c = 0; c < columnCount; c++) {
      const columnKind = buffer.readUInt8(offset); offset += 1;
      const dataTypeId = buffer.readUInt8(offset); offset += 1;
      const length = buffer.readUInt32LE(offset); offset += 4;
      const hasNulls = buffer.readUInt8(offset) !== 0; offset += 1;
      const dataType = ID_TO_DATA_TYPE[dataTypeId];

      let nullBitmap;
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
        const reverseDict = [];
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

function copyBytesInto(buffer, offset, view, byteLength) {
  buffer.copy(new Uint8Array(view.buffer, view.byteOffset, byteLength), 0, offset, offset + byteLength);
  return offset + byteLength;
}

function computeSize(chunk) {
  let total = 4 + 2;

  for (const col of chunk.columns) {
    const isDictionary = col instanceof DictionaryColumn;
    total += 1 + 1 + 4 + 1;

    if (col.hasNulls) {
      const bitmapWordCount = Math.ceil(col.length / 32);
      total += 4 + bitmapWordCount * 4;
    }

    if (isDictionary) {
      total += col.length * 2;
      total += 4;
      for (let i = 0; i < col.reverseDict.length; i++) {
        total += 4 + Buffer.byteLength(col.reverseDict[i], 'utf8');
      }
    } else if (isFixedWidth(col.dataType)) {
      total += col.length * byteWidthFor(col.dataType);
    } else {
      total += 4 + (col.length + 1) * 4 + col.stringBytesUsed;
    }
  }

  return total;
}
