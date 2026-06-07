import { Column } from './column.js';
import { DictionaryColumn } from './dictionary-column.js';
import { DataChunk } from './chunk.js';
import { DataType, isFixedWidth, byteWidthFor, typedArrayFor } from './data-type.js';

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

  static deserialize(buffer) {
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

      let nullBitmap = null;
      if (hasNulls) {
        const bitmapWordCount = buffer.readUInt32LE(offset); offset += 4;
        const bitmapBytes = bitmapWordCount * 4;
        const bitmapBuf = Buffer.allocUnsafe(bitmapBytes);
        buffer.copy(bitmapBuf, 0, offset, offset + bitmapBytes);
        nullBitmap = new Uint32Array(bitmapBuf.buffer, bitmapBuf.byteOffset, bitmapWordCount);
        offset += bitmapBytes;
      }

      if (columnKind === COLUMN_KIND_DICTIONARY) {
        const col = new DictionaryColumn(length || 1);
        col.length = length;
        col.hasNulls = hasNulls;
        if (nullBitmap) col.nullBitmap = nullBitmap;

        const indicesBytes = length * 2;
        const indicesBuf = Buffer.allocUnsafe(indicesBytes);
        buffer.copy(indicesBuf, 0, offset, offset + indicesBytes);
        col.indices = new Uint16Array(indicesBuf.buffer, indicesBuf.byteOffset, length);
        offset += indicesBytes;

        const dictSize = buffer.readUInt32LE(offset); offset += 4;
        const reverseDict = [];
        for (let d = 0; d < dictSize; d++) {
          const strLen = buffer.readUInt32LE(offset); offset += 4;
          const str = buffer.toString('utf8', offset, offset + strLen);
          reverseDict.push(str);
          offset += strLen;
        }
        col.reverseDict = reverseDict;
        col.dictionary = new Map(reverseDict.map((v, i) => [v, i]));
        columns.push(col);
      } else {
        const col = new Column(dataType, length || 1);
        col.length = length;
        col.hasNulls = hasNulls;
        if (nullBitmap) col.nullBitmap = nullBitmap;

        if (isFixedWidth(dataType)) {
          const bw = byteWidthFor(dataType);
          const dataBytes = length * bw;
          const dataBuf = Buffer.allocUnsafe(dataBytes);
          buffer.copy(dataBuf, 0, offset, offset + dataBytes);
          const TypedArrayCtor = typedArrayFor(dataType, 1).constructor;
          col.data = new TypedArrayCtor(dataBuf.buffer, dataBuf.byteOffset, length);
          offset += dataBytes;
        } else {
          const stringBytesUsed = buffer.readUInt32LE(offset); offset += 4;
          const offsetsBytes = (length + 1) * 4;
          const offsetsBuf = Buffer.allocUnsafe(offsetsBytes);
          buffer.copy(offsetsBuf, 0, offset, offset + offsetsBytes);
          col.offsets = new Uint32Array(offsetsBuf.buffer, offsetsBuf.byteOffset, length + 1);
          offset += offsetsBytes;
          const strBuf = Buffer.allocUnsafe(stringBytesUsed);
          buffer.copy(strBuf, 0, offset, offset + stringBytesUsed);
          col.stringBytes = new Uint8Array(strBuf.buffer, strBuf.byteOffset, stringBytesUsed);
          col.stringBytesUsed = stringBytesUsed;
          offset += stringBytesUsed;
        }
        columns.push(col);
      }
    }

    return new DataChunk(columns, size);
  }
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
