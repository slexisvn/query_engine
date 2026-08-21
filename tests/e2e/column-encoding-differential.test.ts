import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { Config, DEFAULT_CHUNK_SIZE } from '../../src/config.js';
import { EncodingKind } from '../../src/storage/encoding/encoding-types.js';
import { columnFormOf, ColumnForm, columnRetainedBytes } from '../../src/storage/column-codec.js';
import { Table } from '../../src/storage/table.js';
import { MemoryPageStore } from '../../src/storage/page-store/memory-page-store.js';
import { DataType } from '../../src/storage/data-type.js';

const CHUNKS = 3;
const ROWS = CHUNKS * DEFAULT_CHUNK_SIZE;
const FLAT = 'FLAT';
const AUTO = 'AUTO';
const FORCED_MODES = [EncodingKind.RUN_LENGTH, EncodingKind.BIT_PACKED, EncodingKind.FRAME_OF_REFERENCE];
const MODES = [...FORCED_MODES, AUTO];

const FACT_SCHEMA = [
  'id INTEGER',
  'segment INTEGER',
  'bucket INTEGER',
  'offsetv INTEGER',
  'stamp BIGINT',
  'opt INTEGER',
  'nil INTEGER',
  'name VARCHAR',
  'price DOUBLE',
].join(', ');

const RUN_LENGTH_ROWS = 512;
const BUCKET_COUNT = 16;
const OFFSET_SPAN = 251;
const OPT_NULL_STRIDE = 7;
const STAMP_BASE = 1700000000000;
const DIM_ROWS = BUCKET_COUNT;

function factRows() {
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    rows.push([
      i,
      Math.floor(i / RUN_LENGTH_ROWS),
      i % BUCKET_COUNT,
      -1000 + (i % OFFSET_SPAN),
      STAMP_BASE + i,
      i % OPT_NULL_STRIDE === 0 ? null : i % 100,
      null,
      `row-${String(i % 40).padStart(3, '0')}`,
      (i % 97) / 4,
    ]);
  }
  return rows;
}

function dimRows() {
  return Array.from({ length: DIM_ROWS }, (_, i) => [i, `bucket-${i}`, i * 10]);
}

const CORPUS = [
  'SELECT COUNT(*) AS c FROM fact',
  'SELECT COUNT(id) AS c, COUNT(opt) AS o, COUNT(nil) AS n FROM fact',
  'SELECT SUM(id) AS s, MIN(id) AS lo, MAX(id) AS hi, AVG(id) AS a FROM fact',
  'SELECT SUM(bucket) AS s, MIN(offsetv) AS lo, MAX(offsetv) AS hi FROM fact',
  'SELECT SUM(stamp) AS s, MIN(stamp) AS lo, MAX(stamp) AS hi FROM fact',
  'SELECT SUM(opt) AS s, AVG(opt) AS a, MIN(opt) AS lo FROM fact',
  'SELECT MIN(nil) AS lo, MAX(nil) AS hi, SUM(nil) AS s FROM fact',
  'SELECT COUNT(*) AS c FROM fact WHERE id = 4095',
  'SELECT COUNT(*) AS c FROM fact WHERE id < 100',
  'SELECT COUNT(*) AS c FROM fact WHERE id BETWEEN 2000 AND 2500',
  'SELECT COUNT(*) AS c FROM fact WHERE id IN (0, 1, 2047, 2048, 6143)',
  'SELECT COUNT(*) AS c FROM fact WHERE id NOT IN (0, 1, 2047)',
  'SELECT COUNT(*) AS c FROM fact WHERE segment = 5',
  'SELECT COUNT(*) AS c FROM fact WHERE segment >= 8 AND bucket < 4',
  'SELECT COUNT(*) AS c FROM fact WHERE offsetv < 0',
  'SELECT COUNT(*) AS c FROM fact WHERE offsetv = -1000',
  'SELECT COUNT(*) AS c FROM fact WHERE stamp > 1700000003000',
  'SELECT COUNT(*) AS c FROM fact WHERE opt IS NULL',
  'SELECT COUNT(*) AS c FROM fact WHERE opt IS NOT NULL',
  'SELECT COUNT(*) AS c FROM fact WHERE nil IS NULL',
  'SELECT COUNT(*) AS c FROM fact WHERE opt > 50 OR opt IS NULL',
  'SELECT COUNT(*) AS c FROM fact WHERE NOT (bucket < 8)',
  'SELECT COUNT(*) AS c FROM fact WHERE id % 7 = 0',
  "SELECT COUNT(*) AS c FROM fact WHERE name LIKE 'row-00%'",
  'SELECT segment, COUNT(*) AS c FROM fact GROUP BY segment ORDER BY segment',
  'SELECT bucket, COUNT(*) AS c, SUM(id) AS s, AVG(offsetv) AS a FROM fact GROUP BY bucket ORDER BY bucket',
  'SELECT bucket, MIN(opt) AS lo, MAX(opt) AS hi, COUNT(opt) AS c FROM fact GROUP BY bucket ORDER BY bucket',
  'SELECT segment, bucket, COUNT(*) AS c FROM fact WHERE id < 1500 GROUP BY segment, bucket ORDER BY segment, bucket',
  'SELECT name, COUNT(*) AS c FROM fact GROUP BY name ORDER BY name LIMIT 5',
  'SELECT bucket, SUM(stamp) AS s FROM fact GROUP BY bucket ORDER BY bucket',
  'SELECT segment, COUNT(*) AS c FROM fact GROUP BY segment HAVING COUNT(*) > 0 ORDER BY segment',
  'SELECT id, bucket, offsetv FROM fact WHERE id BETWEEN 3000 AND 3010 ORDER BY id',
  'SELECT id, opt FROM fact WHERE opt IS NULL AND id < 60 ORDER BY id',
  'SELECT id FROM fact ORDER BY id DESC LIMIT 8',
  'SELECT id, offsetv FROM fact ORDER BY offsetv, id LIMIT 12',
  'SELECT DISTINCT segment FROM fact ORDER BY segment',
  'SELECT DISTINCT bucket, segment FROM fact WHERE id < 900 ORDER BY bucket, segment',
  'SELECT COUNT(DISTINCT opt) AS c FROM fact',
  'SELECT id, id + bucket AS plus, id - offsetv AS minus, bucket * 3 AS times FROM fact WHERE id < 20 ORDER BY id',
  'SELECT id, (id * 2) + (bucket - 1) AS mixed FROM fact WHERE id BETWEEN 100 AND 110 ORDER BY id',
  'SELECT id, opt + bucket AS nullable FROM fact WHERE id < 20 ORDER BY id',
  'SELECT id, CASE WHEN bucket < 4 THEN 0 ELSE 1 END AS band FROM fact WHERE id < 20 ORDER BY id',
  'SELECT id, COALESCE(opt, -1) AS filled FROM fact WHERE id < 20 ORDER BY id',
  'SELECT SUM(id + bucket) AS s FROM fact',
  'SELECT AVG(id * 1.0) AS a FROM fact WHERE id < 500',
  'SELECT f.bucket, d.label, COUNT(*) AS c FROM fact f JOIN dim d ON f.bucket = d.id GROUP BY f.bucket, d.label ORDER BY f.bucket',
  'SELECT COUNT(*) AS c FROM fact f JOIN dim d ON f.bucket = d.id WHERE f.id < 1000',
  'SELECT COUNT(*) AS c FROM fact f LEFT JOIN dim d ON f.segment = d.id',
  'SELECT COUNT(*) AS c FROM fact WHERE bucket IN (SELECT id FROM dim WHERE weight > 100)',
  'SELECT COUNT(*) AS c FROM fact WHERE id > (SELECT MAX(id) FROM dim)',
  'SELECT COUNT(*) AS c FROM fact f WHERE EXISTS (SELECT 1 FROM dim d WHERE d.id = f.bucket)',
  'WITH hot AS (SELECT id, bucket FROM fact WHERE segment = 3) SELECT COUNT(*) AS c, SUM(bucket) AS s FROM hot',
  'SELECT bucket, COUNT(*) AS c FROM (SELECT bucket FROM fact WHERE id < 2000) x GROUP BY bucket ORDER BY bucket',
  'SELECT segment FROM fact WHERE segment < 2 UNION SELECT id FROM dim WHERE id < 3 ORDER BY segment',
  'SELECT DISTINCT segment FROM fact EXCEPT SELECT id FROM dim WHERE id > 5 ORDER BY segment',
  'SELECT DISTINCT bucket FROM fact INTERSECT SELECT id FROM dim ORDER BY bucket',
];

const WASM_CORPUS = [
  'SELECT SUM(id) AS s, MIN(id) AS lo, MAX(id) AS hi FROM fact',
  'SELECT id, (id * 2) - bucket AS e FROM fact WHERE id < 30 ORDER BY id',
  'SELECT id, (opt + 1) * 2 AS e FROM fact WHERE id < 30 ORDER BY id',
  'SELECT bucket, SUM(id) AS s FROM fact GROUP BY bucket ORDER BY bucket',
  'SELECT SUM(offsetv) AS s, AVG(offsetv) AS a FROM fact',
];

const savedConfig = {
  columnEncoding: Config.columnEncoding,
  forcedColumnEncoding: Config.forcedColumnEncoding,
  wasmMinChunkSize: Config.wasmMinChunkSize,
};

function applyMode(mode) {
  Config.columnEncoding = mode !== FLAT;
  Config.forcedColumnEncoding = mode === FLAT || mode === AUTO ? '' : mode;
}

async function buildEngine(mode, { wasm = false } = {}) {
  applyMode(mode);

  const catalog = new Catalog();
  const engine = new QueryEngine(catalog);
  if (wasm) await engine.enableWasm();

  await engine.run(`CREATE TABLE fact (${FACT_SCHEMA})`);
  const fact = catalog.getTableStorage('FACT');
  await fact.insertRows(factRows());
  await fact.flush();

  await engine.run('CREATE TABLE dim (id INTEGER, label VARCHAR, weight INTEGER)');
  const dim = catalog.getTableStorage('DIM');
  await dim.insertRows(dimRows());
  await dim.flush();

  return { engine, catalog };
}

async function runCorpus(engine, corpus) {
  const results = [];
  for (const sql of corpus) {
    results.push((await engine.run(sql)).rows);
  }
  return results;
}

async function storedColumnForms(catalog, tableName) {
  const table = catalog.getTableStorage(tableName);
  const forms = [];
  for (const pageId of table.pageIds) {
    const chunk = await table.pageCache.readPage(pageId);
    for (const column of chunk.columns) {
      forms.push(columnFormOf(column) === ColumnForm.ENCODED ? column.encoded.kind : ColumnForm.FLAT);
    }
  }
  return forms;
}

describe('column encodings do not change query results', () => {
  const baseline = {};
  let flatEngine;

  beforeAll(async () => {
    const built = await buildEngine(FLAT);
    flatEngine = built.engine;
    baseline.rows = await runCorpus(flatEngine, CORPUS);
    baseline.forms = await storedColumnForms(built.catalog, 'FACT');
  });

  afterAll(() => {
    flatEngine.close();
    Object.assign(Config, savedConfig);
  });

  it('stores nothing encoded when encoding is switched off', () => {
    expect(new Set(baseline.forms)).toEqual(new Set([ColumnForm.FLAT]));
  });

  for (const mode of MODES) {
    describe(mode, () => {
      let engine;
      let forms;
      let rows;

      beforeAll(async () => {
        const built = await buildEngine(mode);
        engine = built.engine;
        forms = await storedColumnForms(built.catalog, 'FACT');
        rows = await runCorpus(engine, CORPUS);
      });

      afterAll(() => {
        engine.close();
      });

      it('really stores columns in this encoding', () => {
        const expected = mode === AUTO ? FORCED_MODES : [mode];
        expect(forms.some(form => expected.includes(form))).toBe(true);
      });

      it('answers every query in the corpus exactly as the flat build does', () => {
        for (let i = 0; i < CORPUS.length; i++) {
          expect({ sql: CORPUS[i], rows: rows[i] }).toEqual({ sql: CORPUS[i], rows: baseline.rows[i] });
        }
      });
    });
  }
});

describe('column encodings under the wasm vectorized path', () => {
  const baseline = {};
  let flatEngine;

  beforeAll(async () => {
    const built = await buildEngine(FLAT, { wasm: true });
    flatEngine = built.engine;
    Config.wasmMinChunkSize = 1;
    baseline.rows = await runCorpus(flatEngine, WASM_CORPUS);
    Config.wasmMinChunkSize = savedConfig.wasmMinChunkSize;
  });

  afterAll(() => {
    flatEngine.close();
    Object.assign(Config, savedConfig);
  });

  for (const mode of MODES) {
    it(`matches the flat build for ${mode}`, async () => {
      const { engine } = await buildEngine(mode, { wasm: true });
      Config.wasmMinChunkSize = 1;
      const rows = await runCorpus(engine, WASM_CORPUS);
      Config.wasmMinChunkSize = savedConfig.wasmMinChunkSize;
      engine.close();

      expect(rows).toEqual(baseline.rows);
    });
  }
});

describe('column encodings shrink what storage retains', () => {
  const MEMORY_SCHEMA = [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'SEGMENT', dataType: DataType.INT32 },
    { name: 'BUCKET', dataType: DataType.INT32 },
    { name: 'OFFSETV', dataType: DataType.INT32 },
    { name: 'STAMP', dataType: DataType.INT64 },
    { name: 'OPT', dataType: DataType.INT32 },
  ];

  async function perColumnBytes(mode) {
    applyMode(mode);
    const store = new MemoryPageStore();
    const table = new Table('MEM', MEMORY_SCHEMA, store);
    await table.insertRows(factRows().map(row => [row[0], row[1], row[2], row[3], BigInt(row[4]), row[5]]));
    await table.flush();

    const perColumn = new Array(MEMORY_SCHEMA.length).fill(0);
    for (const chunk of store.pages.values()) {
      chunk.columns.forEach((column, index) => { perColumn[index] += columnRetainedBytes(column); });
    }
    return perColumn;
  }

  const total = bytes => bytes.reduce((sum, value) => sum + value, 0);

  afterAll(() => {
    Object.assign(Config, savedConfig);
  });

  it('retains less than half the bytes the flat build does', async () => {
    const flat = await perColumnBytes(FLAT);
    const auto = await perColumnBytes(AUTO);

    expect(total(auto)).toBeLessThan(total(flat) / 2);
  });

  it('never lets automatic selection grow a column beyond its flat size', async () => {
    const flat = await perColumnBytes(FLAT);
    const auto = await perColumnBytes(AUTO);

    auto.forEach((bytes, index) => {
      expect({ column: MEMORY_SCHEMA[index].name, bytes }).toEqual({
        column: MEMORY_SCHEMA[index].name,
        bytes: Math.min(bytes, flat[index]),
      });
    });
  });
});
