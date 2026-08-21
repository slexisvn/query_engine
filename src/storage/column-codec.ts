import { Column } from './column.js';
import { DictionaryColumn } from './dictionary-column.js';
import type { AnyColumn } from './chunk.js';
import { DataType, isFixedWidth, byteWidthFor, typedArrayCtorFor } from './data-type.js';
import { bitmapWordCount } from '../utils/bitmap.js';
import type { Allocator } from './sab-arena.js';
import {
  UINT8_BYTES, UINT16_BYTES, UINT32_BYTES, utf8RecordBytes,
  type ByteReader, type ByteWriter,
} from './encoding/byte-io.js';
import { encoderForId, encoderForKind } from './encoding/registry.js';

export enum ColumnForm {
  FLAT = 'FLAT',
  DICTIONARY = 'DICTIONARY',
  ENCODED = 'ENCODED',
}

const RECORD_HEADER_BYTES = UINT8_BYTES + UINT8_BYTES + UINT32_BYTES + UINT8_BYTES;
const DICTIONARY_INDEX_BYTES = UINT16_BYTES;
const ENCODER_ID_BYTES = UINT8_BYTES;

const DATA_TYPE_IDS: Record<DataType, number> = {
  [DataType.BOOLEAN]: 0,
  [DataType.INT32]: 1,
  [DataType.INT64]: 2,
  [DataType.FLOAT64]: 3,
  [DataType.DECIMAL]: 4,
  [DataType.VARCHAR]: 5,
  [DataType.DATE]: 6,
  [DataType.TIMESTAMP]: 7,
};

const DATA_TYPES_BY_ID: ReadonlyMap<number, DataType> = new Map(
  Object.entries(DATA_TYPE_IDS).map(([name, id]) => [id, name as DataType]),
);

interface ColumnRecordHeader {
  readonly dataType: DataType;
  readonly length: number;
  readonly hasNulls: boolean;
  readonly nullBitmap: Uint32Array;
  readonly allocator: Allocator;
}

interface ColumnFormCodec {
  readonly form: ColumnForm;
  readonly id: number;
  payloadBytes(column: AnyColumn): number;
  retainedBytes(column: AnyColumn): number;
  write(writer: ByteWriter, column: AnyColumn): void;
  read(reader: ByteReader, header: ColumnRecordHeader): AnyColumn;
}

const flatCodec: ColumnFormCodec = {
  form: ColumnForm.FLAT,
  id: 0,

  payloadBytes(column: AnyColumn): number {
    const flat = column as Column;
    return isFixedWidth(flat.dataType)
      ? flat.length * byteWidthFor(flat.dataType)
      : UINT32_BYTES + (flat.length + 1) * UINT32_BYTES + flat.stringBytesUsed!;
  },

  retainedBytes(column: AnyColumn): number {
    const flat = column as Column;
    return isFixedWidth(flat.dataType)
      ? flat.data!.byteLength
      : flat.offsets!.byteLength + flat.stringBytes!.byteLength;
  },

  write(writer: ByteWriter, column: AnyColumn): void {
    const flat = column as Column;
    if (isFixedWidth(flat.dataType)) {
      writer.bytes(flat.data!, flat.length * byteWidthFor(flat.dataType));
      return;
    }
    writer.u32(flat.stringBytesUsed!);
    writer.bytes(flat.offsets!, (flat.length + 1) * UINT32_BYTES);
    writer.bytes(flat.stringBytes!, flat.stringBytesUsed!);
  },

  read(reader: ByteReader, header: ColumnRecordHeader): AnyColumn {
    const { dataType, length, hasNulls, nullBitmap, allocator } = header;
    if (isFixedWidth(dataType)) {
      const data = reader.typed(typedArrayCtorFor(dataType), length);
      return Column.fromParts({ dataType, data, nullBitmap, length, hasNulls, allocator });
    }
    const stringBytesUsed = reader.u32();
    const offsets = reader.typed(Uint32Array, length + 1);
    const stringBytes = reader.typed(Uint8Array, stringBytesUsed);
    return Column.fromParts({ dataType, offsets, stringBytes, stringBytesUsed, nullBitmap, length, hasNulls, allocator });
  },
};

const dictionaryCodec: ColumnFormCodec = {
  form: ColumnForm.DICTIONARY,
  id: 1,

  payloadBytes(column: AnyColumn): number {
    const dictionary = column as DictionaryColumn;
    let total = dictionary.length * DICTIONARY_INDEX_BYTES + UINT32_BYTES;
    for (const value of dictionary.reverseDict) total += utf8RecordBytes(value);
    return total;
  },

  retainedBytes(column: AnyColumn): number {
    const dictionary = column as DictionaryColumn;
    let total = dictionary.indices.byteLength;
    for (const value of dictionary.reverseDict) total += utf8RecordBytes(value);
    return total;
  },

  write(writer: ByteWriter, column: AnyColumn): void {
    const dictionary = column as DictionaryColumn;
    writer.bytes(dictionary.indices, dictionary.length * DICTIONARY_INDEX_BYTES);
    writer.u32(dictionary.reverseDict.length);
    for (const value of dictionary.reverseDict) writer.utf8(value);
  },

  read(reader: ByteReader, header: ColumnRecordHeader): AnyColumn {
    const { length, hasNulls, nullBitmap, allocator } = header;
    const indices = reader.typed(Uint16Array, length);
    const dictSize = reader.u32();
    const reverseDict: string[] = new Array(dictSize);
    for (let i = 0; i < dictSize; i++) reverseDict[i] = reader.utf8();
    return DictionaryColumn.fromParts({ indices, reverseDict, nullBitmap, length, hasNulls, allocator });
  },
};

const encodedCodec: ColumnFormCodec = {
  form: ColumnForm.ENCODED,
  id: 2,

  payloadBytes(column: AnyColumn): number {
    return ENCODER_ID_BYTES + (column as Column).encoded!.byteSize();
  },

  retainedBytes(column: AnyColumn): number {
    return (column as Column).encoded!.byteSize();
  },

  write(writer: ByteWriter, column: AnyColumn): void {
    const vector = (column as Column).encoded!;
    writer.u8(encoderForKind(vector.kind).id);
    vector.writeTo(writer);
  },

  read(reader: ByteReader, header: ColumnRecordHeader): AnyColumn {
    const { dataType, length, hasNulls, nullBitmap, allocator } = header;
    const encoded = encoderForId(reader.u8()).read(reader, dataType, length);
    return Column.fromEncoded({ dataType, encoded, nullBitmap, length, hasNulls, allocator });
  },
};

const FORM_CODECS: ReadonlyArray<ColumnFormCodec> = [flatCodec, dictionaryCodec, encodedCodec];

const CODECS_BY_FORM: ReadonlyMap<ColumnForm, ColumnFormCodec> =
  new Map(FORM_CODECS.map(codec => [codec.form, codec]));

const CODECS_BY_ID: ReadonlyMap<number, ColumnFormCodec> =
  new Map(FORM_CODECS.map(codec => [codec.id, codec]));

export function columnFormOf(column: AnyColumn): ColumnForm {
  if (column instanceof DictionaryColumn) return ColumnForm.DICTIONARY;
  return column.encoded !== null ? ColumnForm.ENCODED : ColumnForm.FLAT;
}

function codecFor(column: AnyColumn): ColumnFormCodec {
  return CODECS_BY_FORM.get(columnFormOf(column))!;
}

function nullBitmapBytes(column: AnyColumn): number {
  return column.hasNulls ? UINT32_BYTES + bitmapWordCount(column.length) * UINT32_BYTES : 0;
}

export function columnRecordBytes(column: AnyColumn): number {
  return RECORD_HEADER_BYTES + nullBitmapBytes(column) + codecFor(column).payloadBytes(column);
}

export function columnRetainedBytes(column: AnyColumn): number {
  return column.nullBitmap.byteLength + codecFor(column).retainedBytes(column);
}

export function chunkRecordBytes(columns: ReadonlyArray<AnyColumn>): number {
  let total = 0;
  for (const column of columns) total += columnRecordBytes(column);
  return total;
}

export function writeChunkRecords(writer: ByteWriter, columns: ReadonlyArray<AnyColumn>): void {
  for (const column of columns) writeColumnRecord(writer, column);
}

export function readChunkRecords(reader: ByteReader, count: number): AnyColumn[] {
  const columns: AnyColumn[] = new Array(count);
  for (let c = 0; c < count; c++) columns[c] = readColumnRecord(reader);
  return columns;
}

export function writeColumnRecord(writer: ByteWriter, column: AnyColumn): void {
  const codec = codecFor(column);
  writer.u8(codec.id);
  writer.u8(DATA_TYPE_IDS[column.dataType]);
  writer.u32(column.length);
  writer.u8(column.hasNulls ? 1 : 0);

  if (column.hasNulls) {
    const wordCount = bitmapWordCount(column.length);
    writer.u32(wordCount);
    writer.words(column.nullBitmap, wordCount);
  }

  codec.write(writer, column);
}

export function readColumnRecord(reader: ByteReader): AnyColumn {
  const codec = CODECS_BY_ID.get(reader.u8());
  if (!codec) throw new Error('Unknown column form in serialized chunk');

  const dataTypeId = reader.u8();
  const dataType = DATA_TYPES_BY_ID.get(dataTypeId);
  if (!dataType) throw new Error(`Unknown column data type id ${dataTypeId}`);

  const length = reader.u32();
  const hasNulls = reader.u8() !== 0;
  const allocator = reader.allocator;

  let nullBitmap: Uint32Array;
  if (hasNulls) {
    const wordCount = reader.u32();
    nullBitmap = reader.typed(Uint32Array, wordCount);
  } else {
    nullBitmap = allocator.acquire(Uint32Array, bitmapWordCount(Math.max(length, 1)));
  }

  return codec.read(reader, { dataType, length, hasNulls, nullBitmap, allocator });
}
