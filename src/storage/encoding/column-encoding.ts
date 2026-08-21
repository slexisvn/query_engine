import { Config } from '../../config.js';
import { Column } from '../column.js';
import { DataChunk, type AnyColumn } from '../chunk.js';
import { byteWidthFor, type DataType } from '../data-type.js';
import { COLUMN_ENCODERS } from './registry.js';
import { ENCODABLE_TYPES, summarizeIntegers } from './integer-values.js';
import type { ColumnEncoder, EncodedVector, EncodingKind, IntegerArray, IntegerColumnStats } from './encoding-types.js';

interface EncodingChoice {
  readonly encoder: ColumnEncoder;
  readonly bytes: number;
}

function flatBytes(stats: IntegerColumnStats, dataType: DataType): number {
  return stats.length * byteWidthFor(dataType);
}

export function chooseEncoder(stats: IntegerColumnStats, dataType: DataType): ColumnEncoder | null {
  const forced = Config.forcedColumnEncoding;
  if (forced.length > 0) {
    const encoder = COLUMN_ENCODERS.get(forced as EncodingKind);
    if (!encoder) return null;
    return encoder.plan(stats, dataType) === null ? null : encoder;
  }

  if (stats.length < Config.encodingMinRows) return null;

  let best: EncodingChoice | null = null;
  for (const encoder of COLUMN_ENCODERS.values()) {
    const plan = encoder.plan(stats, dataType);
    if (plan === null || !plan.withinThreshold) continue;
    if (best === null || plan.bytes < best.bytes) best = { encoder, bytes: plan.bytes };
  }

  if (best === null) return null;
  return best.bytes <= flatBytes(stats, dataType) * Config.encodingMinCompressionRatio ? best.encoder : null;
}

export function encodeColumnValues(column: Column): EncodedVector | null {
  if (!Config.columnEncoding) return null;
  if (column.encoded !== null) return column.encoded;
  if (!ENCODABLE_TYPES.has(column.dataType) || column.length === 0) return null;

  const values = column.data as IntegerArray | undefined;
  if (!values) return null;

  const stats = summarizeIntegers(values, column.length);
  const encoder = chooseEncoder(stats, column.dataType);
  if (encoder === null) return null;

  return encoder.encode({ dataType: column.dataType, length: column.length, values, stats });
}

function encodedColumn(column: AnyColumn): AnyColumn {
  if (!(column instanceof Column)) return column;

  const encoded = encodeColumnValues(column);
  if (encoded === null || encoded === column.encoded) return column;

  return Column.fromEncoded({
    dataType: column.dataType,
    encoded,
    nullBitmap: column.nullBitmap,
    length: column.length,
    hasNulls: column.hasNulls,
    allocator: column.allocator,
  });
}

export function encodeChunkColumns(chunk: DataChunk): DataChunk {
  const source = chunk.selectionVector ? chunk.flatten() : chunk;
  const columns = source.columns.map(encodedColumn);

  if (source === chunk && columns.every((column, index) => column === chunk.columns[index])) {
    return chunk;
  }
  return new DataChunk(columns, source.size);
}
