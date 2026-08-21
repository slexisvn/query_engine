import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { InMemoryRelation } from '../../src/dataframe/in-memory-relation.js';
import { DataType } from '../../src/storage/data-type.js';
import { Config } from '../../src/config.js';
import { DEFAULT_CHUNK_SIZE } from '../../src/config.js';

const CHUNKS = 3;
const ROWS = CHUNKS * DEFAULT_CHUNK_SIZE;
const NULL_STRIDE = 100;
const NULL_ROWS = Math.ceil(ROWS / NULL_STRIDE);

class CountingStorage {
  constructor(inner) {
    this.inner = inner;
    this.chunksScanned = 0;
    this.counting = false;
  }

  getSchema() { return this.inner.getSchema(); }
  rowCount() { return this.inner.rowCount(); }
  getColumnIndex(name) { return this.inner.getColumnIndex(name); }
  scanAll() { return this.inner.scanAll(); }

  async *scan(pruner) {
    for await (const chunk of this.inner.scan(pruner)) {
      if (this.counting) this.chunksScanned++;
      yield chunk;
    }
  }
}

function pagedRows() {
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    rows.push([
      i,
      `n${String(i).padStart(5, '0')}`,
      i % NULL_STRIDE === 0 ? null : i,
      null,
      i < DEFAULT_CHUNK_SIZE && i % 2 === 0 ? null : i,
    ]);
  }
  return rows;
}

const PAGED_SCHEMA = 'id INTEGER, name VARCHAR, opt INTEGER, nil INTEGER, sparse INTEGER';
const SPARSE_NULL_ROWS = DEFAULT_CHUNK_SIZE / 2;

async function makeEngine() {
  const catalog = new Catalog();
  const engine = new QueryEngine(catalog);

  await engine.run(`CREATE TABLE big (${PAGED_SCHEMA})`);
  const big = catalog.getTableStorage('BIG');
  await big.insertRows(pagedRows());
  await big.flush();
  const counted = new CountingStorage(big);
  catalog.registerTableStorage('BIG', counted);

  await engine.run('CREATE TABLE tiny (id INTEGER, label VARCHAR)');
  const tiny = catalog.getTableStorage('TINY');
  await tiny.insertRows([[1, 'a'], [2, 'b'], [3, 'c']]);
  await tiny.flush();

  await engine.run('CREATE TABLE blank (id INTEGER, label VARCHAR)');

  const dfSchema = [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'OPT', dataType: DataType.INT32 },
  ];
  const dfRows = Array.from({ length: ROWS }, (_, i) => [i, i % NULL_STRIDE === 0 ? null : i]);
  catalog.registerTable('MEM', dfSchema);
  catalog.registerTableStorage('MEM', InMemoryRelation.fromRows(dfRows, dfSchema));

  return { engine, counted };
}

async function measure(engine, counted, sql, pruningEnabled) {
  Config.zoneMapPruning = pruningEnabled;
  await engine.run(sql);
  counted.chunksScanned = 0;
  counted.counting = true;
  const result = await engine.run(sql);
  counted.counting = false;
  return { rows: result.rows, chunksScanned: counted.chunksScanned };
}

const CORPUS = [
  'SELECT COUNT(*) AS c FROM big WHERE id = 42',
  'SELECT COUNT(*) AS c FROM big WHERE id < 10',
  'SELECT COUNT(*) AS c FROM big WHERE id <= 0',
  'SELECT COUNT(*) AS c FROM big WHERE id > 6000',
  'SELECT COUNT(*) AS c FROM big WHERE id >= 6143',
  'SELECT COUNT(*) AS c FROM big WHERE 500 > id',
  'SELECT COUNT(*) AS c FROM big WHERE id BETWEEN 100 AND 300',
  'SELECT COUNT(*) AS c FROM big WHERE id NOT BETWEEN 0 AND 6142',
  'SELECT COUNT(*) AS c FROM big WHERE id IN (1, 2, 6000)',
  'SELECT COUNT(*) AS c FROM big WHERE id NOT IN (1, 2, 6000)',
  'SELECT COUNT(*) AS c FROM big WHERE id <> 7',
  'SELECT COUNT(*) AS c FROM big WHERE id > 100 AND id < 200',
  'SELECT COUNT(*) AS c FROM big WHERE id < 100 OR id > 6000',
  'SELECT COUNT(*) AS c FROM big WHERE NOT (id < 6000)',
  'SELECT COUNT(*) AS c FROM big WHERE NOT (id > 100 AND id < 200)',
  "SELECT COUNT(*) AS c FROM big WHERE name LIKE 'n00001%'",
  "SELECT COUNT(*) AS c FROM big WHERE name NOT LIKE 'n0%'",
  "SELECT COUNT(*) AS c FROM big WHERE name >= 'n06000'",
  'SELECT COUNT(*) AS c FROM big WHERE opt IS NULL',
  'SELECT COUNT(*) AS c FROM big WHERE opt IS NOT NULL',
  'SELECT COUNT(*) AS c FROM big WHERE opt > 6000',
  'SELECT COUNT(*) AS c FROM big WHERE opt = 5000 OR opt IS NULL',
  'SELECT COUNT(*) AS c FROM big WHERE NOT (opt > 6000)',
  'SELECT COUNT(*) AS c FROM big WHERE opt IN (5, 6000)',
  'SELECT COUNT(*) AS c FROM big WHERE nil IS NULL',
  'SELECT COUNT(*) AS c FROM big WHERE nil IS NOT NULL',
  'SELECT COUNT(*) AS c FROM big WHERE nil > 0',
  'SELECT COUNT(*) AS c FROM big WHERE nil = 1 OR id = 3',
  'SELECT COUNT(*) AS c FROM big WHERE sparse IS NULL',
  'SELECT COUNT(*) AS c FROM big WHERE sparse IS NOT NULL',
  'SELECT COUNT(*) AS c FROM big WHERE sparse < 10',
  'SELECT COUNT(*) AS c FROM big WHERE NOT (sparse < 10)',
  'SELECT COUNT(*) AS c FROM big WHERE sparse = 3 OR sparse IS NULL',
  'SELECT SUM(id) AS s, MIN(opt) AS lo, MAX(opt) AS hi FROM big WHERE id > 5000',
  'SELECT id, opt FROM big WHERE id BETWEEN 4000 AND 4003 ORDER BY id',
  'SELECT COUNT(*) AS c FROM tiny WHERE id = 2',
  'SELECT COUNT(*) AS c FROM tiny WHERE id > 99',
  "SELECT COUNT(*) AS c FROM tiny WHERE label LIKE 'a%'",
  'SELECT COUNT(*) AS c FROM blank WHERE id = 1',
  'SELECT COUNT(*) AS c FROM blank WHERE id IS NULL',
  'SELECT COUNT(*) AS c FROM mem WHERE id > 6000',
  'SELECT COUNT(*) AS c FROM mem WHERE opt IS NULL',
  'SELECT COUNT(*) AS c FROM mem WHERE id = 4096',
  'SELECT COUNT(*) AS c FROM big b JOIN tiny t ON b.id = t.id WHERE b.id > 6000',
  'SELECT COUNT(*) AS c FROM big b JOIN tiny t ON b.id = t.id WHERE t.id = 2',
  'SELECT COUNT(*) AS c FROM big WHERE id IN (SELECT id FROM tiny WHERE id > 1)',
  'SELECT COUNT(*) AS c FROM big WHERE id > (SELECT MAX(id) FROM tiny)',
  'SELECT g, COUNT(*) AS c FROM (SELECT id % 3 AS g FROM big WHERE id < 300) x GROUP BY g ORDER BY g',
];

describe('zone-map pruning', () => {
  let engine;
  let counted;
  let savedPruning;

  beforeEach(async () => {
    savedPruning = Config.zoneMapPruning;
    ({ engine, counted } = await makeEngine());
  });

  afterEach(() => {
    Config.zoneMapPruning = savedPruning;
  });

  describe('chunks are really skipped', () => {
    it('scans one chunk instead of all of them for a selective equality', async () => {
      const pruned = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE id = 42', true);
      const full = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE id = 42', false);

      expect(full.chunksScanned).toBe(CHUNKS);
      expect(pruned.chunksScanned).toBe(1);
      expect(pruned.rows).toEqual(full.rows);
    });

    it('scans nothing when no chunk can hold a match', async () => {
      const pruned = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE id > 99999', true);

      expect(pruned.chunksScanned).toBe(0);
      expect(pruned.rows).toEqual([{ c: 0 }]);
    });

    it('scans nothing for a predicate over an all-NULL column', async () => {
      const pruned = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE nil > 0', true);

      expect(pruned.chunksScanned).toBe(0);
      expect(pruned.rows).toEqual([{ c: 0 }]);
    });

    it('scans every chunk when the predicate cannot be analysed, and prunes when it can', async () => {
      const opaque = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE id % 7 = 0', true);
      const analysable = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE id > 6000', true);

      expect(opaque.chunksScanned).toBe(CHUNKS);
      expect(analysable.chunksScanned).toBe(1);
    });

    it('narrows a range predicate to the chunks the range touches', async () => {
      const sql = `SELECT COUNT(*) AS c FROM big WHERE id BETWEEN ${DEFAULT_CHUNK_SIZE} AND ${DEFAULT_CHUNK_SIZE + 10}`;
      const pruned = await measure(engine, counted, sql, true);

      expect(pruned.chunksScanned).toBe(1);
      expect(pruned.rows).toEqual([{ c: 11 }]);
    });
  });

  describe('unsound skips are refused', () => {
    it('keeps a NULL-bearing chunk whose range excludes the literal when NULLs can still match', async () => {
      const excluded = 'SELECT COUNT(*) AS c FROM big WHERE opt = 99999';
      const withNulls = 'SELECT COUNT(*) AS c FROM big WHERE opt = 99999 OR opt IS NULL';

      const skipped = await measure(engine, counted, excluded, true);
      const kept = await measure(engine, counted, withNulls, true);
      const full = await measure(engine, counted, withNulls, false);

      expect(skipped.chunksScanned).toBe(0);
      expect(skipped.rows).toEqual([{ c: 0 }]);
      expect(kept.chunksScanned).toBe(CHUNKS);
      expect(kept.rows).toEqual(full.rows);
      expect(kept.rows[0].c).toBe(NULL_ROWS);
    });

    it('keeps every chunk holding NULLs for IS NULL while skipping the chunks without any', async () => {
      const everywhere = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE opt IS NULL', true);
      const firstChunkOnly = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE sparse IS NULL', true);

      expect(everywhere.chunksScanned).toBe(CHUNKS);
      expect(everywhere.rows).toEqual([{ c: NULL_ROWS }]);
      expect(firstChunkOnly.chunksScanned).toBe(1);
      expect(firstChunkOnly.rows).toEqual([{ c: SPARSE_NULL_ROWS }]);
    });

    it('keeps every chunk of an all-NULL column for IS NULL and skips them all for IS NOT NULL', async () => {
      const isNull = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE nil IS NULL', true);
      const isNotNull = await measure(engine, counted, 'SELECT COUNT(*) AS c FROM big WHERE nil IS NOT NULL', true);

      expect(isNull.chunksScanned).toBe(CHUNKS);
      expect(isNull.rows).toEqual([{ c: ROWS }]);
      expect(isNotNull.chunksScanned).toBe(0);
      expect(isNotNull.rows).toEqual([{ c: 0 }]);
    });
  });

  describe('differential corpus', () => {
    it('returns identical results with pruning on and off, and skips work along the way', async () => {
      let prunedTotal = 0;
      let fullTotal = 0;

      for (const sql of CORPUS) {
        const pruned = await measure(engine, counted, sql, true);
        const full = await measure(engine, counted, sql, false);

        expect({ sql, rows: pruned.rows }).toEqual({ sql, rows: full.rows });
        expect(pruned.chunksScanned).toBeLessThanOrEqual(full.chunksScanned);
        prunedTotal += pruned.chunksScanned;
        fullTotal += full.chunksScanned;
      }

      expect(prunedTotal).toBeLessThan(fullTotal);
    });
  });
});
