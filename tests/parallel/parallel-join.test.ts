import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { FragmentPool } from '../../src/parallel/fragment-pool.js';
import { Config } from '../../src/config.js';

const pool = new FragmentPool(2, 4);
afterAll(() => pool.close());

const savedJoinThreshold = Config.parallelJoinThreshold;
afterEach(() => { Config.parallelJoinThreshold = savedJoinThreshold; });

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, Math.max(1, values.length));
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function mockStorage(chunks, schema) {
  const totalRows = chunks.reduce((sum, c) => sum + c.size, 0);
  return {
    getSchema: () => schema,
    rowCount: () => totalRows,
    getColumnIndex: (name) => schema.findIndex(s => s.name.toUpperCase() === name.toUpperCase()),
    async *scan() { for (const c of chunks) yield c; },
  };
}

function buildCatalog() {
  const catalog = new Catalog();
  const n = 300;

  const leftSchema = [
    { name: 'id', dataType: 'INT32' },
    { name: 'k', dataType: 'INT32' },
    { name: 'tag', dataType: 'VARCHAR' },
    { name: 'v', dataType: 'INT32' },
  ];
  const leftCols = { id: [], k: [], tag: [], v: [] };
  for (let i = 0; i < n; i++) {
    leftCols.id.push(i);
    leftCols.k.push(i % 11 === 0 ? null : i % 40);
    leftCols.tag.push(`t${i % 6}`);
    leftCols.v.push(i % 13 === 0 ? null : (i * 7) % 100);
  }
  catalog.registerTable('L', leftSchema);
  catalog.registerTableStorage('L', mockStorage([
    makeChunk([
      { type: 'INT32', values: leftCols.id },
      { type: 'INT32', values: leftCols.k },
      { type: 'VARCHAR', values: leftCols.tag },
      { type: 'INT32', values: leftCols.v },
    ]),
  ], leftSchema));

  const rightSchema = [
    { name: 'rid', dataType: 'INT32' },
    { name: 'k', dataType: 'INT32' },
    { name: 'w', dataType: 'INT32' },
  ];
  const rightCols = { rid: [], k: [], w: [] };
  for (let i = 0; i < n / 2; i++) {
    rightCols.rid.push(1000 + i);
    rightCols.k.push(i % 9 === 0 ? null : i % 55);
    rightCols.w.push((i * 3) % 90);
  }
  catalog.registerTable('R', rightSchema);
  catalog.registerTableStorage('R', mockStorage([
    makeChunk([
      { type: 'INT32', values: rightCols.rid },
      { type: 'INT32', values: rightCols.k },
      { type: 'INT32', values: rightCols.w },
    ]),
  ], rightSchema));

  return catalog;
}

async function runBoth(sql) {
  Config.parallelJoinThreshold = savedJoinThreshold;
  const serialEngine = new QueryEngine(buildCatalog());
  const serial = (await serialEngine.run(sql)).rows;
  serialEngine.close();

  Config.parallelJoinThreshold = 0;
  const parallelEngine = new QueryEngine(buildCatalog());
  parallelEngine.executor.setParallelContext(null, null, pool);
  const parallel = (await parallelEngine.run(sql)).rows;
  parallelEngine.close();

  return { serial, parallel };
}

function normalized(rows) {
  return rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]))).sort();
}

const QUERIES = [
  'SELECT l.id, r.rid, r.w FROM L l JOIN R r ON l.k = r.k',
  'SELECT l.id, r.rid FROM L l LEFT JOIN R r ON l.k = r.k',
  'SELECT l.id, r.rid FROM L l RIGHT JOIN R r ON l.k = r.k',
  'SELECT l.id, r.rid FROM L l FULL OUTER JOIN R r ON l.k = r.k',
  'SELECT l.id, r.rid, r.w FROM L l JOIN R r ON l.k = r.k AND l.v < r.w',
  'SELECT l.id FROM L l WHERE EXISTS (SELECT 1 FROM R r WHERE r.k = l.k)',
  'SELECT l.id FROM L l WHERE NOT EXISTS (SELECT 1 FROM R r WHERE r.k = l.k)',
  'SELECT l.id FROM L l WHERE l.k IN (SELECT r.k FROM R r)',
  'SELECT l.tag, COUNT(*) AS c FROM L l JOIN R r ON l.k = r.k GROUP BY l.tag',
  'SELECT a.id, b.id AS bid FROM L a JOIN L b ON a.k = b.k AND a.id <> b.id',
  'SELECT l.id, r.rid FROM L l JOIN R r ON l.k = r.k WHERE l.v > 50 AND r.w < 70',
  'SELECT l.id, r.rid FROM L l LEFT JOIN R r ON l.k = r.k WHERE l.v > 50',
];

describe('parallel radix hash-join matches serial', () => {
  for (const sql of QUERIES) {
    it(`parallel == serial: ${sql.slice(0, 60)}`, async () => {
      const { serial, parallel } = await runBoth(sql);
      expect(parallel.length).toBe(serial.length);
      expect(normalized(parallel)).toEqual(normalized(serial));
    });
  }

  it('actually uses the parallel join path without silent serial fallback', async () => {
    Config.parallelJoinThreshold = 0;
    const engine = new QueryEngine(buildCatalog());
    engine.executor.setParallelContext(null, null, pool);

    let parallelRuns = 0;
    let serialFallbacks = 0;
    const originalRunJoinStream = pool.runJoinStream.bind(pool);
    const originalBufferedSerial = engine.executor._runBufferedSerialJoin.bind(engine.executor);
    const originalSubPipeline = engine.executor._executeSubPipeline.bind(engine.executor);
    pool.runJoinStream = (...args) => { parallelRuns++; return originalRunJoinStream(...args); };
    engine.executor._runBufferedSerialJoin = async (...args) => { serialFallbacks++; return originalBufferedSerial(...args); };
    engine.executor._executeSubPipeline = async (...args) => { serialFallbacks++; return originalSubPipeline(...args); };

    try {
      const result = await engine.run('SELECT l.id, r.rid FROM L l JOIN R r ON l.k = r.k');
      expect(result.rows.length).toBeGreaterThan(0);
      expect(parallelRuns).toBe(1);
      expect(serialFallbacks).toBe(0);
    } finally {
      pool.runJoinStream = originalRunJoinStream;
      engine.close();
    }
  });

  it('pushes scan→filter fragments down to workers for both join sides', async () => {
    const sql = 'SELECT l.id, r.rid FROM L l JOIN R r ON l.k = r.k WHERE l.v > 50 AND r.w < 70';
    const serialEngine = new QueryEngine(buildCatalog());
    const expected = (await serialEngine.run(sql)).rows;
    serialEngine.close();

    Config.parallelJoinThreshold = 0;
    const engine = new QueryEngine(buildCatalog(), { statistics: new Map() });
    engine.executor.physicalPlanner.costModel.C_COMPARE = 1e7;
    engine.executor.setParallelContext(null, null, pool);
    let captured = null;
    const original = engine.executor._prepareParallelJoin.bind(engine.executor);
    engine.executor._prepareParallelJoin = (...args) => {
      captured = original(...args);
      return captured;
    };

    try {
      const got = (await engine.run(sql)).rows;
      expect(normalized(got)).toEqual(normalized(expected));
      expect(captured).not.toBeNull();
      expect(captured.buildSide.storage).toBeTruthy();
      expect(captured.probeSide.storage).toBeTruthy();
      const stageCount = captured.spec.build.stages.length + captured.spec.probe.stages.length;
      expect(stageCount).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });

  it('actually uses the parallel aggregate path without silent serial fallback', async () => {
    const savedAgg = Config.parallelAggThreshold;
    Config.parallelAggThreshold = 0;
    const sql = 'SELECT tag, SUM(v) AS s, COUNT(*) AS c FROM L GROUP BY tag';

    const serialEngine = new QueryEngine(buildCatalog());
    const expected = (await serialEngine.run(sql)).rows;
    serialEngine.close();

    const engine = new QueryEngine(buildCatalog());
    engine.executor.setParallelContext(null, null, pool);
    let parallelRuns = 0;
    let serialFallbacks = 0;
    const originalRunAggregate = pool.runAggregate.bind(pool);
    const originalSub = engine.executor._executeSubPipeline.bind(engine.executor);
    pool.runAggregate = async (...args) => { parallelRuns++; return originalRunAggregate(...args); };
    engine.executor._executeSubPipeline = async (...args) => { serialFallbacks++; return originalSub(...args); };

    try {
      const got = (await engine.run(sql)).rows;
      expect(normalized(got)).toEqual(normalized(expected));
      expect(parallelRuns).toBe(1);
      expect(serialFallbacks).toBe(0);
    } finally {
      pool.runAggregate = originalRunAggregate;
      Config.parallelAggThreshold = savedAgg;
      engine.close();
    }
  });

  it('falls back to serial when build side exceeds the memory limit', async () => {
    const savedMemory = Config.memoryLimit;
    Config.memoryLimit = 1;
    try {
      const { serial, parallel } = await runBoth('SELECT l.id, r.rid FROM L l JOIN R r ON l.k = r.k');
      expect(normalized(parallel)).toEqual(normalized(serial));
    } finally {
      Config.memoryLimit = savedMemory;
    }
  });
});
