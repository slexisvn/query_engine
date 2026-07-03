import { DataChunk } from '../../storage/chunk.js';
import type { DataType } from '../../storage/data-type.js';

export interface DedupTarget {
  seen: Set<string>;
  schema: DataType[] | null;
  _legacyChunks: DataChunk[];
}

export function dedupProcess(target: DedupTarget, chunk: DataChunk): DataChunk {
  if (!target.schema) {
    target.schema = chunk.columns.map((c) => c.dataType);
  }

  const sv = new Uint32Array(chunk.size);
  let count = 0;

  for (let i = 0; i < chunk.size; i++) {
    const rowIdx = chunk.activeRowIndex(i);
    let key = '';
    for (let c = 0; c < chunk.columns.length; c++) {
      if (c > 0) key += '|';
      key += String(chunk.columns[c].get(rowIdx));
    }

    if (!target.seen.has(key)) {
      target.seen.add(key);
      sv[count++] = rowIdx;
    }
  }

  if (count === 0) return new DataChunk(chunk.columns, 0);
  if (count === chunk.size) return chunk;

  const result = new DataChunk(chunk.columns, count);
  result.setSelectionVector(sv.slice(0, count), count);
  return result;
}

export async function dedupConsume(target: DedupTarget, result: DataChunk): Promise<void> {
  if (!target._legacyChunks) target._legacyChunks = [];
  if (result.size > 0) {
    target._legacyChunks.push(result.selectionVector ? result.flatten() : result);
  }
}

export function dedupFinalize(target: DedupTarget): DataChunk[] {
  return target._legacyChunks || [];
}
