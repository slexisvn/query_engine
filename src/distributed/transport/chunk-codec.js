import { DataType, isFixedWidth, byteWidthFor, typedArrayFor } from '../../storage/data-type.js';
import { Column } from '../../storage/column.js';
import { DictionaryColumn } from '../../storage/dictionary-column.js';
import { DataChunk } from '../../storage/chunk.js';
import { createBitmap, setBit, testBit } from '../../utils/bitmap.js';

const TYPE_ID = {
  [DataType.BOOLEAN]: 0,
  [DataType.INT32]: 1,
  [DataType.INT64]: 2,
  [DataType.FLOAT64]: 3,
  [DataType.DECIMAL]: 4,
  [DataType.VARCHAR]: 5,
  [DataType.DATE]: 6,
  [DataType.TIMESTAMP]: 7,
};

const ID_TO_TYPE = Object.fromEntries(
  Object.entries(TYPE_ID).map(([k, v]) => [v, k])
);

const HEADER_MAGIC = 0x51454348;
const COLUMN_HEADER_BYTES = 6;

export class ChunkCodec {
  encode(chunk) {
    const flatChunk = chunk.selectionVector ? chunk.flatten() : chunk;
    const columnCount = flatChunk.columns.length;
    const rowCount = flatChunk.size;

    const columnBuffers = new Array(columnCount);
    let totalPayloadBytes = 0;

    for (let c = 0; c < columnCount; c++) {
      const col = flatChunk.columns[c];
      const buf = this._encodeColumn(col, rowCount);
      columnBuffers[c] = buf;
      totalPayloadBytes += buf.length;
    }

    const headerSize = 10 + columnCount * COLUMN_HEADER_BYTES;
    const totalSize = headerSize + totalPayloadBytes;
    const result = Buffer.allocUnsafe(totalSize);

    result.writeUInt32LE(HEADER_MAGIC, 0);
    result.writeUInt16LE(columnCount, 4);
    result.writeUInt32LE(rowCount, 6);

    let headerOffset = 10;
    for (let c = 0; c < columnCount; c++) {
      const col = flatChunk.columns[c];
      const typeId = TYPE_ID[col.dataType];
      const isDictionary = col instanceof DictionaryColumn ? 1 : 0;
      result.writeUInt8(typeId, headerOffset);
      result.writeUInt8(isDictionary, headerOffset + 1);
      result.writeUInt32LE(columnBuffers[c].length, headerOffset + 2);
      headerOffset += COLUMN_HEADER_BYTES;
    }

    let payloadOffset = headerSize;
    for (let c = 0; c < columnCount; c++) {
      columnBuffers[c].copy(result, payloadOffset);
      payloadOffset += columnBuffers[c].length;
    }

    return result;
  }

  decode(buffer) {
    const magic = buffer.readUInt32LE(0);
    if (magic !== HEADER_MAGIC) {
      throw new Error('Invalid chunk codec magic number');
    }

    const columnCount = buffer.readUInt16LE(4);
    const rowCount = buffer.readUInt32LE(6);

    const columnMeta = new Array(columnCount);
    let headerOffset = 10;
    for (let c = 0; c < columnCount; c++) {
      const typeId = buffer.readUInt8(headerOffset);
      const isDictionary = buffer.readUInt8(headerOffset + 1);
      const payloadSize = buffer.readUInt32LE(headerOffset + 2);
      columnMeta[c] = {
        dataType: ID_TO_TYPE[typeId],
        isDictionary: isDictionary === 1,
        payloadSize,
      };
      headerOffset += COLUMN_HEADER_BYTES;
    }

    const columns = new Array(columnCount);
    let payloadOffset = 10 + columnCount * COLUMN_HEADER_BYTES;

    for (let c = 0; c < columnCount; c++) {
      const meta = columnMeta[c];
      const colBuffer = buffer.subarray(payloadOffset, payloadOffset + meta.payloadSize);
      columns[c] = this._decodeColumn(colBuffer, meta.dataType, meta.isDictionary, rowCount);
      payloadOffset += meta.payloadSize;
    }

    return new DataChunk(columns, rowCount);
  }

  _encodeColumn(col, rowCount) {
    if (col instanceof DictionaryColumn) {
      return this._encodeDictionaryColumn(col, rowCount);
    }
    return this._encodeRegularColumn(col, rowCount);
  }

  _encodeRegularColumn(col, rowCount) {
    if (col.dataType === DataType.VARCHAR) {
      return this._encodeVarcharColumn(col, rowCount);
    }

    const bitmapWords = Math.ceil(rowCount / 32);
    const bitmapBytes = bitmapWords * 4;
    const byteWidth = byteWidthFor(col.dataType);
    const dataBytes = rowCount * byteWidth;

    const buf = Buffer.allocUnsafe(1 + bitmapBytes + dataBytes);
    buf.writeUInt8(col.hasNulls ? 1 : 0, 0);

    for (let i = 0; i < bitmapWords; i++) {
      buf.writeUInt32LE(i < col.nullBitmap.length ? col.nullBitmap[i] : 0, 1 + i * 4);
    }

    const dataOffset = 1 + bitmapBytes;
    const src = new Uint8Array(col.data.buffer, col.data.byteOffset, dataBytes);
    for (let i = 0; i < dataBytes; i++) {
      buf[dataOffset + i] = src[i];
    }

    return buf;
  }

  _encodeVarcharColumn(col, rowCount) {
    const bitmapWords = Math.ceil(rowCount / 32);
    const bitmapBytes = bitmapWords * 4;
    const offsetBytes = (rowCount + 1) * 4;
    const stringDataBytes = col.stringBytesUsed;

    const buf = Buffer.allocUnsafe(1 + bitmapBytes + offsetBytes + stringDataBytes);
    buf.writeUInt8(col.hasNulls ? 1 : 0, 0);

    for (let i = 0; i < bitmapWords; i++) {
      buf.writeUInt32LE(i < col.nullBitmap.length ? col.nullBitmap[i] : 0, 1 + i * 4);
    }

    let pos = 1 + bitmapBytes;
    for (let i = 0; i <= rowCount; i++) {
      buf.writeUInt32LE(col.offsets[i], pos);
      pos += 4;
    }

    for (let i = 0; i < stringDataBytes; i++) {
      buf[pos + i] = col.stringBytes[i];
    }

    return buf;
  }

  _encodeDictionaryColumn(col, rowCount) {
    const bitmapWords = Math.ceil(rowCount / 32);
    const bitmapBytes = bitmapWords * 4;
    const dictSize = col.reverseDict.length;

    const encoder = new TextEncoder();
    const encodedStrings = col.reverseDict.map(s => encoder.encode(s));
    let dictPayloadBytes = 4;
    for (const enc of encodedStrings) {
      dictPayloadBytes += 4 + enc.length;
    }

    const indexBytes = rowCount * 2;

    const buf = Buffer.allocUnsafe(1 + bitmapBytes + dictPayloadBytes + indexBytes);
    buf.writeUInt8(col.hasNulls ? 1 : 0, 0);

    for (let i = 0; i < bitmapWords; i++) {
      buf.writeUInt32LE(i < col.nullBitmap.length ? col.nullBitmap[i] : 0, 1 + i * 4);
    }

    let pos = 1 + bitmapBytes;
    buf.writeUInt32LE(dictSize, pos);
    pos += 4;
    for (const enc of encodedStrings) {
      buf.writeUInt32LE(enc.length, pos);
      pos += 4;
      for (let i = 0; i < enc.length; i++) {
        buf[pos + i] = enc[i];
      }
      pos += enc.length;
    }

    for (let i = 0; i < rowCount; i++) {
      buf.writeUInt16LE(col.indices[i], pos);
      pos += 2;
    }

    return buf;
  }

  _decodeColumn(buf, dataType, isDictionary, rowCount) {
    if (isDictionary) {
      return this._decodeDictionaryColumn(buf, rowCount);
    }
    if (dataType === DataType.VARCHAR) {
      return this._decodeVarcharColumn(buf, rowCount);
    }
    return this._decodeFixedColumn(buf, dataType, rowCount);
  }

  _decodeFixedColumn(buf, dataType, rowCount) {
    const col = new Column(dataType, rowCount);
    const bitmapWords = Math.ceil(rowCount / 32);
    const bitmapBytes = bitmapWords * 4;

    col.hasNulls = buf.readUInt8(0) === 1;

    const newBitmap = createBitmap(rowCount);
    for (let i = 0; i < bitmapWords; i++) {
      newBitmap[i] = buf.readUInt32LE(1 + i * 4);
    }
    col.nullBitmap = newBitmap;

    const byteWidth = byteWidthFor(dataType);
    const dataStart = 1 + bitmapBytes;
    const dataBuf = buf.subarray(dataStart, dataStart + rowCount * byteWidth);

    const TypedCtor = typedArrayFor(dataType, 0).constructor;
    const aligned = new ArrayBuffer(rowCount * byteWidth);
    new Uint8Array(aligned).set(dataBuf);
    col.data = new TypedCtor(aligned);

    col.length = rowCount;
    return col;
  }

  _decodeVarcharColumn(buf, rowCount) {
    const col = new Column(DataType.VARCHAR, rowCount);
    const bitmapWords = Math.ceil(rowCount / 32);
    const bitmapBytes = bitmapWords * 4;

    col.hasNulls = buf.readUInt8(0) === 1;

    const newBitmap = createBitmap(rowCount);
    for (let i = 0; i < bitmapWords; i++) {
      newBitmap[i] = buf.readUInt32LE(1 + i * 4);
    }
    col.nullBitmap = newBitmap;

    let pos = 1 + bitmapBytes;
    const offsets = new Uint32Array(rowCount + 1);
    for (let i = 0; i <= rowCount; i++) {
      offsets[i] = buf.readUInt32LE(pos);
      pos += 4;
    }
    col.offsets = offsets;

    const stringDataLen = offsets[rowCount];
    col.stringBytes = new Uint8Array(stringDataLen);
    for (let i = 0; i < stringDataLen; i++) {
      col.stringBytes[i] = buf[pos + i];
    }
    col.stringBytesUsed = stringDataLen;

    col.length = rowCount;
    return col;
  }

  _decodeDictionaryColumn(buf, rowCount) {
    const col = new DictionaryColumn(rowCount);
    const bitmapWords = Math.ceil(rowCount / 32);
    const bitmapBytes = bitmapWords * 4;

    col.hasNulls = buf.readUInt8(0) === 1;

    const newBitmap = createBitmap(rowCount);
    for (let i = 0; i < bitmapWords; i++) {
      newBitmap[i] = buf.readUInt32LE(1 + i * 4);
    }
    col.nullBitmap = newBitmap;

    let pos = 1 + bitmapBytes;
    const dictSize = buf.readUInt32LE(pos);
    pos += 4;

    const decoder = new TextDecoder();
    const reverseDict = new Array(dictSize);
    const dictionary = new Map();
    for (let i = 0; i < dictSize; i++) {
      const strLen = buf.readUInt32LE(pos);
      pos += 4;
      const str = decoder.decode(buf.subarray(pos, pos + strLen));
      reverseDict[i] = str;
      dictionary.set(str, i);
      pos += strLen;
    }
    col.reverseDict = reverseDict;
    col.dictionary = dictionary;

    const indices = new Uint16Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
      indices[i] = buf.readUInt16LE(pos);
      pos += 2;
    }
    col.indices = indices;

    col.length = rowCount;
    return col;
  }
}
