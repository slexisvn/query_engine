import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';

let engine;

beforeEach(() => { engine = new QueryEngine(new Catalog()); });
afterEach(() => engine.close());

describe('DataFrame union', () => {
  it('unions two frames with matching schemas', async () => {
    const a = engine.createDataFrame([{ id: 1 }, { id: 2 }]);
    const b = engine.createDataFrame([{ id: 3 }]);
    const rows = await a.unionAll(b).orderBy('id').collect();
    expect(rows.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it('rejects mismatched column counts', () => {
    const a = engine.createDataFrame([{ id: 1 }]);
    const b = engine.createDataFrame([{ id: 1, extra: 2 }]);
    expect(() => a.union(b)).toThrow(TypeError);
  });

  it('rejects incompatible column types', () => {
    const a = engine.createDataFrame([{ id: 1 }]);
    const b = engine.createDataFrame([{ id: 'text' }]);
    expect(() => a.union(b)).toThrow(TypeError);
  });
});
