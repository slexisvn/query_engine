import { Column } from '../storage/column.js';
import { DictionaryColumn } from '../storage/dictionary-column.js';
import { DataChunk, type AnyColumn } from '../storage/chunk.js';
import { DataType, isFixedWidth, typedArrayCtorFor } from '../storage/data-type.js';
import { isSharedView, type Allocator } from '../storage/sab-arena.js';
import { bitmapWordCount } from '../utils/bitmap.js';
import type { EncodedChunkSet } from './worker-messages.js';

const KIND_FLAT = 0;
const KIND_VARCHAR = 1;
const KIND_DICTIONARY = 2;

const TYPE_BY_ID = [
  DataType.BOOLEAN, DataType.INT32, DataType.INT64, DataType.FLOAT64,
  DataType.DECIMAL, DataType.VARCHAR, DataType.DATE, DataType.TIMESTAMP,
];
const ID_BY_TYPE = new Map(TYPE_BY_ID.map((type, id) => [type, id]));

const REC = {
  KIND: 0,
  TYPE_ID: 1,
  HAS_NULLS: 2,
  DATA_BUF: 3,
  DATA_OFF: 4,
  DATA_LEN: 5,
  NULL_BUF: 6,
  NULL_OFF: 7,
  NULL_WORDS: 8,
  AUX_BUF: 9,
  AUX_OFF: 10,
  AUX_LEN: 11,
  AUX2_BUF: 12,
  AUX2_OFF: 13,
  AUX2_LEN: 14,
  WORDS: 16,
};

function columnIsShared(col: AnyColumn): boolean {
  if (col instanceof DictionaryColumn) {
    return isSharedView(col.indices) && isSharedView(col.nullBitmap);
  }
  if (isFixedWidth(col.dataType)) {
    return isSharedView(col.data) && isSharedView(col.nullBitmap);
  }
  return isSharedView(col.offsets) && isSharedView(col.stringBytes) && isSharedView(col.nullBitmap);
}

function chunkIsShared(chunk: DataChunk, columnIndexes: number[]): boolean {
  for (const i of columnIndexes) {
    if (!columnIsShared(chunk.columns[i])) return false;
  }
  return true;
}

function copyColumn(col: AnyColumn, size: number, allocator: Allocator): AnyColumn {
  const words = bitmapWordCount(Math.max(size, 1));
  const nullBitmap = allocator.acquire(Uint32Array, words);
  nullBitmap.set(col.nullBitmap.subarray(0, Math.min(words, col.nullBitmap.length)));

  if (col instanceof DictionaryColumn) {
    const indices = allocator.acquire(Uint16Array, size);
    indices.set(col.indices.subarray(0, size));
    return DictionaryColumn.fromParts({
      indices, reverseDict: col.reverseDict, nullBitmap,
      length: size, hasNulls: col.hasNulls, allocator,
    });
  }

  if (isFixedWidth(col.dataType)) {
    const data = allocator.acquire(typedArrayCtorFor(col.dataType), size);
    (data as Float64Array).set(col.data!.subarray(0, size) as Float64Array);
    return Column.fromParts({
      dataType: col.dataType, data, nullBitmap,
      length: size, hasNulls: col.hasNulls, allocator,
    });
  }

  const offsets = allocator.acquire(Uint32Array, size + 1);
  offsets.set(col.offsets!.subarray(0, size + 1));
  const stringBytes = allocator.acquire(Uint8Array, col.stringBytesUsed!);
  stringBytes.set(col.stringBytes!.subarray(0, col.stringBytesUsed!));
  return Column.fromParts({
    dataType: col.dataType, offsets, stringBytes, stringBytesUsed: col.stringBytesUsed!,
    nullBitmap, length: size, hasNulls: col.hasNulls, allocator,
  });
}

export function shareChunk(chunk: DataChunk, columnIndexes: number[], arena: Allocator, forceCopy: boolean = false): DataChunk {
  const flat = chunk.selectionVector ? chunk.flatten() : chunk;
  if (!forceCopy && chunkIsShared(flat, columnIndexes)) return flat;
  const needed = new Set(columnIndexes);
  const columns = flat.columns.map((col, i) =>
    needed.has(i) && (forceCopy || !columnIsShared(col)) ? copyColumn(col, flat.size, arena) : col
  );
  return new DataChunk(columns, flat.size);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface DictBlob {
  lengths: Uint32Array;
  count: number;
  blob: Uint8Array;
  totalBytes: number;
}

function writeDictBlob(arena: Allocator, reverseDict: string[]): DictBlob {
  const encoded = reverseDict.map(value => textEncoder.encode(value));
  let totalBytes = 0;
  for (const bytes of encoded) totalBytes += bytes.length;

  const lengths = arena.acquire(Uint32Array, Math.max(encoded.length, 1));
  for (let i = 0; i < encoded.length; i++) lengths[i] = encoded[i].length;

  const blob = arena.acquire(Uint8Array, Math.max(totalBytes, 1));
  let offset = 0;
  for (const bytes of encoded) {
    blob.set(bytes, offset);
    offset += bytes.length;
  }

  return { lengths, count: encoded.length, blob, totalBytes };
}

function readDictBlob(lengths: Uint32Array, count: number, blob: Uint8Array): string[] {
  const reverseDict: string[] = new Array(count);
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const len = lengths[i];
    reverseDict[i] = len === 0 ? '' : textDecoder.decode(blob.subarray(offset, offset + len));
    offset += len;
  }
  return reverseDict;
}

export function encodeChunkSet(chunks: DataChunk[], columnIndexes: number[], arena: Allocator, dictCache: Map<string[], DictBlob> = new Map()): EncodedChunkSet {
  const buffers: ArrayBufferLike[] = [];
  const bufferIds = new Map<ArrayBufferLike, number>();
  const refBuffer = (buffer: ArrayBufferLike): number => {
    let id = bufferIds.get(buffer);
    if (id === undefined) {
      id = buffers.length;
      buffers.push(buffer);
      bufferIds.set(buffer, id);
    }
    return id;
  };

  const colCount = columnIndexes.length;
  const meta = new Uint32Array(chunks.length * colCount * REC.WORDS);
  const sizes = new Uint32Array(chunks.length);

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    sizes[ci] = chunk.size;
    for (let c = 0; c < colCount; c++) {
      const col = chunk.columns[columnIndexes[c]];
      const base = (ci * colCount + c) * REC.WORDS;
      const words = Math.min(bitmapWordCount(Math.max(chunk.size, 1)), col.nullBitmap.length);

      meta[base + REC.HAS_NULLS] = col.hasNulls ? 1 : 0;
      meta[base + REC.NULL_BUF] = refBuffer(col.nullBitmap.buffer);
      meta[base + REC.NULL_OFF] = col.nullBitmap.byteOffset;
      meta[base + REC.NULL_WORDS] = words;

      if (col instanceof DictionaryColumn) {
        let dict = dictCache.get(col.reverseDict);
        if (!dict) {
          dict = writeDictBlob(arena, col.reverseDict);
          dictCache.set(col.reverseDict, dict);
        }
        meta[base + REC.KIND] = KIND_DICTIONARY;
        meta[base + REC.TYPE_ID] = ID_BY_TYPE.get(DataType.VARCHAR)!;
        meta[base + REC.DATA_BUF] = refBuffer(col.indices.buffer);
        meta[base + REC.DATA_OFF] = col.indices.byteOffset;
        meta[base + REC.DATA_LEN] = chunk.size;
        meta[base + REC.AUX_BUF] = refBuffer(dict.lengths.buffer);
        meta[base + REC.AUX_OFF] = dict.lengths.byteOffset;
        meta[base + REC.AUX_LEN] = dict.count;
        meta[base + REC.AUX2_BUF] = refBuffer(dict.blob.buffer);
        meta[base + REC.AUX2_OFF] = dict.blob.byteOffset;
        meta[base + REC.AUX2_LEN] = dict.totalBytes;
      } else if (isFixedWidth(col.dataType)) {
        meta[base + REC.KIND] = KIND_FLAT;
        meta[base + REC.TYPE_ID] = ID_BY_TYPE.get(col.dataType)!;
        meta[base + REC.DATA_BUF] = refBuffer(col.data!.buffer);
        meta[base + REC.DATA_OFF] = col.data!.byteOffset;
        meta[base + REC.DATA_LEN] = chunk.size;
      } else {
        meta[base + REC.KIND] = KIND_VARCHAR;
        meta[base + REC.TYPE_ID] = ID_BY_TYPE.get(col.dataType)!;
        meta[base + REC.DATA_BUF] = refBuffer(col.offsets!.buffer);
        meta[base + REC.DATA_OFF] = col.offsets!.byteOffset;
        meta[base + REC.DATA_LEN] = chunk.size + 1;
        meta[base + REC.AUX_BUF] = refBuffer(col.stringBytes!.buffer);
        meta[base + REC.AUX_OFF] = col.stringBytes!.byteOffset;
        meta[base + REC.AUX_LEN] = col.stringBytesUsed!;
      }
    }
  }

  return { buffers, meta, sizes, colCount };
}

export function transportBytes(chunkSet: EncodedChunkSet): number {
  let total = 0;
  for (const buffer of chunkSet.buffers) total += buffer.byteLength;
  return total;
}

export class ChunkSetReader {
  buffers: ArrayBufferLike[];
  meta: Uint32Array;
  sizes: Uint32Array;
  colCount: number;
  cache: Map<number, DataChunk>;

  constructor({ buffers, meta, sizes, colCount }: EncodedChunkSet) {
    this.buffers = buffers;
    this.meta = meta;
    this.sizes = sizes;
    this.colCount = colCount;
    this.cache = new Map();
  }

  get count(): number {
    return this.sizes.length;
  }

  chunk(index: number): DataChunk {
    let chunk = this.cache.get(index);
    if (!chunk) {
      chunk = this._decode(index);
      this.cache.set(index, chunk);
    }
    return chunk;
  }

  _decode(index: number): DataChunk {
    const size = this.sizes[index];
    const columns: AnyColumn[] = new Array(this.colCount);
    for (let c = 0; c < this.colCount; c++) {
      const base = (index * this.colCount + c) * REC.WORDS;
      const meta = this.meta;
      const hasNulls = meta[base + REC.HAS_NULLS] === 1;
      const nullBitmap = new Uint32Array(
        this.buffers[meta[base + REC.NULL_BUF]],
        meta[base + REC.NULL_OFF],
        meta[base + REC.NULL_WORDS],
      );
      const kind = meta[base + REC.KIND];
      const dataType = TYPE_BY_ID[meta[base + REC.TYPE_ID]];
      const dataBuffer = this.buffers[meta[base + REC.DATA_BUF]];
      const dataOffset = meta[base + REC.DATA_OFF];
      const dataLength = meta[base + REC.DATA_LEN];

      if (kind === KIND_DICTIONARY) {
        const lengths = new Uint32Array(this.buffers[meta[base + REC.AUX_BUF]], meta[base + REC.AUX_OFF], Math.max(meta[base + REC.AUX_LEN], 1));
        const blob = new Uint8Array(this.buffers[meta[base + REC.AUX2_BUF]], meta[base + REC.AUX2_OFF], Math.max(meta[base + REC.AUX2_LEN], 1));
        columns[c] = DictionaryColumn.fromParts({
          indices: new Uint16Array(dataBuffer, dataOffset, dataLength),
          reverseDict: readDictBlob(lengths, meta[base + REC.AUX_LEN], blob),
          nullBitmap,
          length: size,
          hasNulls,
        });
      } else if (kind === KIND_FLAT) {
        columns[c] = Column.fromParts({
          dataType,
          data: new (typedArrayCtorFor(dataType))(dataBuffer, dataOffset, dataLength),
          nullBitmap,
          length: size,
          hasNulls,
        });
      } else {
        columns[c] = Column.fromParts({
          dataType,
          offsets: new Uint32Array(dataBuffer, dataOffset, dataLength),
          stringBytes: new Uint8Array(this.buffers[meta[base + REC.AUX_BUF]], meta[base + REC.AUX_OFF], meta[base + REC.AUX_LEN]),
          stringBytesUsed: meta[base + REC.AUX_LEN],
          nullBitmap,
          length: size,
          hasNulls,
        });
      }
    }
    return new DataChunk(columns, size);
  }
}
