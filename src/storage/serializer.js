import { Column } from './column.js';
import { DictionaryColumn } from './dictionary-column.js';
import { DataChunk } from './chunk.js';
import { DataType, isFixedWidth, typedArrayFor } from './data-type.js';

function bufferToBase64(typedArray) {
  if (!typedArray) return null;
  return Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).toString('base64');
}

function base64ToBuffer(b64Str, TypedArrayConstructor) {
  if (!b64Str) return null;
  const buf = Buffer.from(b64Str, 'base64');
  return new TypedArrayConstructor(buf.buffer, buf.byteOffset, buf.byteLength / TypedArrayConstructor.BYTES_PER_ELEMENT);
}

export class ChunkSerializer {
  static serialize(chunk) {
    const serializedColumns = chunk.columns.map(col => {
      if (col instanceof DictionaryColumn) {
        return {
          type: 'dictionary',
          dataType: col.dataType,
          capacity: col.capacity,
          length: col.length,
          hasNulls: col.hasNulls,
          nullBitmap: bufferToBase64(col.nullBitmap),
          reverseDict: col.reverseDict,
          indices: bufferToBase64(col.indices)
        };
      } else {
        return {
          type: 'flat',
          dataType: col.dataType,
          capacity: col.capacity,
          length: col.length,
          hasNulls: col.hasNulls,
          nullBitmap: bufferToBase64(col.nullBitmap),
          data: col.data ? bufferToBase64(col.data) : null,
          offsets: col.offsets ? bufferToBase64(col.offsets) : null,
          stringBytes: col.stringBytes ? bufferToBase64(col.stringBytes) : null,
          stringBytesUsed: col.stringBytesUsed || 0
        };
      }
    });

    return JSON.stringify({
      size: chunk.size,
      columns: serializedColumns
    });
  }

  static deserialize(jsonStr) {
    const data = JSON.parse(jsonStr);
    const columns = data.columns.map(colData => {
      if (colData.type === 'dictionary') {
        const col = new DictionaryColumn(colData.capacity);
        col.length = colData.length;
        col.hasNulls = colData.hasNulls;
        col.nullBitmap = base64ToBuffer(colData.nullBitmap, Uint32Array);
        col.reverseDict = colData.reverseDict;
        col.dictionary = new Map(colData.reverseDict.map((v, i) => [v, i]));
        col.indices = base64ToBuffer(colData.indices, Uint16Array);
        return col;
      } else {
        const col = new Column(colData.dataType, colData.capacity);
        col.length = colData.length;
        col.hasNulls = colData.hasNulls;
        if (colData.nullBitmap) {
          col.nullBitmap = base64ToBuffer(colData.nullBitmap, Uint32Array);
        }
        
        if (isFixedWidth(colData.dataType)) {
          const T = typedArrayFor(colData.dataType, 1).constructor;
          col.data = base64ToBuffer(colData.data, T);
        } else {
          col.offsets = base64ToBuffer(colData.offsets, Uint32Array);
          col.stringBytes = base64ToBuffer(colData.stringBytes, Uint8Array);
          col.stringBytesUsed = colData.stringBytesUsed;
        }
        return col;
      }
    });

    return new DataChunk(columns, data.size);
  }
}
