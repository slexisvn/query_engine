import { DataChunk } from '../../storage/chunk.js';
import { DictionaryColumn } from '../../storage/dictionary-column.js';
import type { ColumnValue } from '../../storage/data-type.js';

export type AccumulatorState = ColumnValue | { sum: number; count: number } | ColumnValue[];

export interface PartialGroup {
  groupValues: ColumnValue[];
  states: AccumulatorState[];
}

const BIGINT_TAG = '$bigint';

interface TaggedBigInt {
  [BIGINT_TAG]: string;
}

function tagBigInt(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value;
}

function untagBigInt(_key: string, value: unknown): unknown {
  const tagged = value as TaggedBigInt | null;
  return tagged && typeof tagged === 'object' && typeof tagged[BIGINT_TAG] === 'string'
    ? BigInt(tagged[BIGINT_TAG])
    : value;
}

export function encodePartialGroup(record: PartialGroup): string {
  return JSON.stringify([record.groupValues, record.states], tagBigInt);
}

export function decodePartialGroup(encoded: string): PartialGroup {
  const [groupValues, states] = JSON.parse(encoded, untagBigInt) as [ColumnValue[], AccumulatorState[]];
  return { groupValues, states };
}

export function partialGroupsToChunk(records: PartialGroup[]): DataChunk {
  const column = new DictionaryColumn(Math.max(records.length, 1));
  for (let i = 0; i < records.length; i++) column.set(i, encodePartialGroup(records[i]));
  column.length = records.length;
  return new DataChunk([column], records.length);
}

export function chunkToPartialGroups(chunk: DataChunk): PartialGroup[] {
  const records: PartialGroup[] = new Array(chunk.size);
  for (let i = 0; i < chunk.size; i++) {
    records[i] = decodePartialGroup(chunk.getValue(i, 0) as string);
  }
  return records;
}
