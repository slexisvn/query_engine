import type { AnyColumn, DataChunk, SelectionVector } from './chunk.js';
import type { ColumnValue } from './data-type.js';

export type OrderedValue = string | number | bigint | boolean;

export interface ValueRange {
  readonly min: OrderedValue;
  readonly max: OrderedValue;
}

export interface ColumnZoneMap {
  readonly range: ValueRange | null;
  readonly hasNulls: boolean;
}

export interface ChunkZoneMap {
  readonly rowCount: number;
  readonly columns: ReadonlyArray<ColumnZoneMap>;
}

export interface ChunkPruner {
  canSkip(zoneMap: ChunkZoneMap): boolean;
}

export function isBefore(left: OrderedValue, right: OrderedValue): boolean {
  if (typeof left === 'bigint' && typeof right === 'bigint') return left < right;
  if (typeof left === 'string' || typeof right === 'string') return String(left) < String(right);
  return Number(left) < Number(right);
}

function summarizeColumn(column: AnyColumn, size: number, selection: SelectionVector | null): ColumnZoneMap {
  let min: OrderedValue | null = null;
  let max: OrderedValue | null = null;
  let hasNulls = false;

  for (let i = 0; i < size; i++) {
    const value: ColumnValue = column.get(selection ? selection[i] : i);
    if (value === null || value === undefined) {
      hasNulls = true;
      continue;
    }
    if (min === null || max === null) {
      min = value;
      max = value;
      continue;
    }
    if (isBefore(value, min)) min = value;
    else if (isBefore(max, value)) max = value;
  }

  return { range: min === null || max === null ? null : { min, max }, hasNulls };
}

export function buildChunkZoneMap(chunk: DataChunk): ChunkZoneMap {
  const selection = chunk.selectionVector;
  const columns = chunk.columns.map(column => summarizeColumn(column, chunk.size, selection));
  return { rowCount: chunk.size, columns };
}
