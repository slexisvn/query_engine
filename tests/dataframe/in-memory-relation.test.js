import { describe, it, expect } from 'vitest';
import { InMemoryRelation } from '../../src/dataframe/in-memory-relation.js';
import { DEFAULT_CHUNK_SIZE } from '../../src/storage/chunk.js';
import { DataType } from '../../src/storage/data-type.js';

async function collect(relation) {
  const rows = [];
  const schema = relation.getSchema();
  for await (const chunk of relation.scan()) {
    for (let i = 0; i < chunk.size; i++) {
      const row = {};
      for (let j = 0; j < schema.length; j++) row[schema[j].name] = chunk.columns[j].get(i);
      rows.push(row);
    }
  }
  return rows;
}

describe('InMemoryRelation', () => {
  it('builds from object rows and infers types', () => {
    const rel = InMemoryRelation.fromRows([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    expect(rel.getSchema().map(c => c.dataType)).toEqual([DataType.INT32, DataType.VARCHAR]);
    expect(rel.rowCount()).toBe(2);
  });

  it('honors a declared schema', () => {
    const rel = InMemoryRelation.fromRows([{ v: 1 }], [{ name: 'v', dataType: DataType.INT64 }]);
    expect(rel.getSchema()[0].dataType).toBe(DataType.INT64);
  });

  it('builds from columns', async () => {
    const rel = InMemoryRelation.fromColumns({ a: [1, 2], b: ['x', 'y'] });
    expect(await collect(rel)).toEqual([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
  });

  it('round-trips nulls', async () => {
    const rel = InMemoryRelation.fromRows([{ x: 1 }, { x: null }]);
    expect(await collect(rel)).toEqual([{ x: 1 }, { x: null }]);
  });

  it('rolls over multiple chunks past the chunk size', async () => {
    const total = DEFAULT_CHUNK_SIZE + 5;
    const rows = Array.from({ length: total }, (_, i) => ({ x: i }));
    const rel = InMemoryRelation.fromRows(rows);
    expect(rel.rowCount()).toBe(total);
    expect(rel.chunks.length).toBeGreaterThan(1);
    const collected = await collect(rel);
    expect(collected.length).toBe(total);
    expect(collected[total - 1].x).toBe(total - 1);
  });
});
