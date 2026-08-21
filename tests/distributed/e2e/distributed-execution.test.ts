import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Catalog } from '../../../src/catalog/catalog.js';
import { QueryEngine } from '../../../src/index.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { DictionaryColumn } from '../../../src/storage/dictionary-column.js';
import { DataType } from '../../../src/storage/data-type.js';
import { NodeDescriptor, NodeRole } from '../../../src/distributed/cluster/node-descriptor.js';
import { RoundRobinPartitionStrategy } from '../../../src/distributed/partition/partition-strategy.js';
import { Config } from '../../../src/config.js';

const SCHEMA = [
  { name: 'id', dataType: DataType.INT32 },
  { name: 'val', dataType: DataType.INT32 },
  { name: 'cat', dataType: DataType.VARCHAR },
];
const CATS = ['x', 'yy', 'zz', 'w'];

function storage(rows) {
  const id = new Column(DataType.INT32, Math.max(1, rows.length));
  const val = new Column(DataType.INT32, Math.max(1, rows.length));
  const cat = new DictionaryColumn(Math.max(1, rows.length));
  rows.forEach(([a, b, c]) => { id.append(a); val.append(b); cat.append(c); });
  const chunk = new DataChunk([id, val, cat], rows.length);
  return {
    getSchema: () => SCHEMA,
    rowCount: () => rows.length,
    getColumnIndex: (n) => SCHEMA.findIndex(s => s.name.toUpperCase() === n.toUpperCase()),
    async *scan() { if (rows.length) yield chunk; },
  };
}

const ALL = [];
for (let i = 1; i <= 200; i++) ALL.push([i, (i * 7) % 50, i % 11 === 0 ? null : CATS[i % 4]]);
const P0 = ALL.filter(([id]) => id % 3 === 0);
const P1 = ALL.filter(([id]) => id % 3 === 1);
const P2 = ALL.filter(([id]) => id % 3 === 2);

async function makeNode(nodeId, port, role) {
  const engine = new QueryEngine(new Catalog());
  engine.catalog.registerTable('SALES', SCHEMA);
  await engine.enableDistributed({ nodeId, port, role });
  await engine.distributed.transport.start();
  return engine;
}

function wire(node, peers) {
  for (const p of peers) {
    node.distributed.transport.registerNode(p.id, '127.0.0.1', p.port);
    if (p.id !== node.distributed.localNode.nodeId) {
      node.distributed.clusterManager.addNode(new NodeDescriptor({ nodeId: p.id, host: '127.0.0.1', port: p.port, role: NodeRole.WORKER }));
    }
  }
}

describe('distributed execution (real fan-out across in-process nodes)', () => {
  let coord, w1, w2, w3, oracle;
  const savedTimeout = Config.coordinatorTimeoutMs;

  beforeAll(async () => {
    Config.coordinatorTimeoutMs = 15000;
    coord = await makeNode('coord', 9460, NodeRole.COORDINATOR);
    w1 = await makeNode('w1', 9461, NodeRole.WORKER);
    w2 = await makeNode('w2', 9462, NodeRole.WORKER);
    w3 = await makeNode('w3', 9463, NodeRole.WORKER);
    const peers = [{ id: 'coord', port: 9460 }, { id: 'w1', port: 9461 }, { id: 'w2', port: 9462 }, { id: 'w3', port: 9463 }];
    for (const n of [coord, w1, w2, w3]) wire(n, peers);

    coord.catalog.registerTableStorage('SALES', storage([]));
    w1.catalog.registerTableStorage('SALES', storage(P0));
    w2.catalog.registerTableStorage('SALES', storage(P1));
    w3.catalog.registerTableStorage('SALES', storage(P2));
    coord.distributed.partitionMap.registerTable('SALES', new RoundRobinPartitionStrategy(), 3,
      new Map([[0, ['w1']], [1, ['w2']], [2, ['w3']]]));

    oracle = new QueryEngine(new Catalog());
    oracle.catalog.registerTable('SALES', SCHEMA);
    oracle.catalog.registerTableStorage('SALES', storage(ALL));
  });

  afterAll(async () => {
    Config.coordinatorTimeoutMs = savedTimeout;
    for (const n of [coord, w1, w2, w3]) {
      try { await n.distributed.transport.stop(); } catch (_) {}
    }
  });

  const canon = (rows) => rows.map(r =>
    Object.keys(r).sort().map(k => {
      let v = r[k];
      if (typeof v === 'number') v = Math.round(v * 1e6) / 1e6;
      return `${k.toUpperCase()}=${v}`;
    }).join(',')
  ).sort();

  const cases = [
    'SELECT COUNT(*) AS c, SUM(val) AS s, AVG(val) AS a, MIN(val) AS mn, MAX(val) AS mx FROM SALES',
    'SELECT COUNT(*) AS c FROM SALES WHERE val > 25',
    'SELECT val % 4 AS g, COUNT(*) AS c, SUM(val) AS s, AVG(val) AS a FROM SALES GROUP BY val % 4',
    'SELECT val % 4 AS g, AVG(val) AS a FROM SALES GROUP BY val % 4 HAVING COUNT(*) > 10',
    'SELECT cat AS g, COUNT(*) AS c, SUM(val) AS s, AVG(val) AS a FROM SALES GROUP BY cat',
    'SELECT cat AS g, MIN(val) AS mn, MAX(val) AS mx FROM SALES WHERE val > 10 GROUP BY cat',
    'SELECT id, val FROM SALES WHERE val > 25',
    'SELECT id, val * 2 AS d FROM SALES WHERE val < 40',
    'SELECT cat AS g, COUNT(*) AS c FROM SALES GROUP BY cat HAVING COUNT(*) > 5',
  ];

  for (const sql of cases) {
    it(`matches single-node and fans out: ${sql.slice(0, 46)}...`, async () => {
      const expected = canon((await oracle.run(sql)).rows);
      const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
      expect(got).toEqual(expected);
    });
  }

  describe('DISTINCT aggregates are not decomposed per partition', () => {
    const distinctCases = [
      'SELECT COUNT(DISTINCT val) AS c FROM SALES',
      'SELECT COUNT(DISTINCT cat) AS c FROM SALES',
      'SELECT COUNT(DISTINCT val) AS c FROM SALES WHERE val > 20',
      'SELECT cat AS g, COUNT(DISTINCT val) AS c FROM SALES GROUP BY cat',
      'SELECT SUM(DISTINCT val) AS s FROM SALES',
    ];
    for (const sql of distinctCases) {
      it(`matches single-node: ${sql.slice(0, 46)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('counts distinct values once, not once per partition', async () => {
      const rows = (await coord.distributed.coordinator.execute('SELECT COUNT(DISTINCT val) AS c FROM SALES')).rows;
      const single = (await oracle.run('SELECT COUNT(DISTINCT val) AS c FROM SALES')).rows;
      expect(Number(rows[0].c)).toBe(Number(single[0].c));
      expect(Number(rows[0].c)).toBeLessThan(200);
    });
  });

  const ordered = [
    'SELECT id, val FROM SALES ORDER BY val DESC, id ASC',
    'SELECT id, val FROM SALES WHERE val > 20 ORDER BY val ASC, id ASC LIMIT 12',
    'SELECT t.id AS tid, t.val AS tv FROM SALES t JOIN SALES d ON t.id = d.id ORDER BY t.id, t.val',
  ];
  for (const sql of ordered) {
    it(`order-sensitive matches single-node: ${sql.slice(0, 44)}...`, async () => {
      const norm = rows => rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])));
      const expected = norm((await oracle.run(sql)).rows);
      const got = norm((await coord.distributed.coordinator.execute(sql)).rows);
      expect(got).toEqual(expected);
    });
  }

  const unordered = [
    'SELECT DISTINCT cat FROM SALES',
    'SELECT DISTINCT val % 5 AS m, cat FROM SALES',
    'SELECT id, SUM(val) OVER (PARTITION BY cat) AS w FROM SALES',
    'SELECT t.cat AS g, COUNT(*) AS c, SUM(d.val) AS s FROM SALES t JOIN SALES d ON t.id = d.id GROUP BY t.cat',
    'SELECT t.id AS tid, d.val AS dv FROM SALES t LEFT JOIN SALES d ON t.id = d.id WHERE t.val > 30',
    // joins on `cat` (NOT the partition key `id`) force a hash-SHUFFLE join across workers
    'SELECT COUNT(*) AS c, SUM(t.val) AS s FROM SALES t JOIN SALES d ON t.cat = d.cat WHERE t.id < 15 AND d.id < 15',
    'SELECT t.id AS tid, d.id AS did FROM SALES t LEFT JOIN SALES d ON t.cat = d.cat WHERE t.id < 6 AND d.val < 4',
  ];
  for (const sql of unordered) {
    it(`matches single-node (ORDER BY/DISTINCT/window/JOIN): ${sql.slice(0, 38)}...`, async () => {
      const expected = canon((await oracle.run(sql)).rows);
      const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
      expect(got).toEqual(expected);
    });
  }
  describe('ORDER BY on a column that is not in the SELECT list', () => {
    const orderedRows = rows => rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])));
    const nonProjectedSortKey = [
      'SELECT id FROM SALES ORDER BY val DESC, id ASC LIMIT 8',
      'SELECT id FROM SALES ORDER BY val ASC, id ASC LIMIT 8',
      'SELECT id FROM SALES ORDER BY val DESC, id ASC LIMIT 8 OFFSET 5',
      'SELECT id FROM SALES ORDER BY val ASC, id DESC LIMIT 12 OFFSET 20',
      'SELECT id FROM SALES ORDER BY val DESC, id ASC',
      'SELECT id FROM SALES WHERE val > 20 ORDER BY val DESC, id ASC LIMIT 10',
      'SELECT id * 2 AS d FROM SALES ORDER BY val DESC, id ASC LIMIT 8',
      'SELECT cat AS c FROM SALES ORDER BY val DESC, id ASC LIMIT 8',
      'SELECT id FROM SALES ORDER BY cat ASC, val DESC, id ASC LIMIT 15',
    ];
    for (const sql of nonProjectedSortKey) {
      it(`keeps global order: ${sql.slice(0, 52)}...`, async () => {
        const expected = orderedRows((await oracle.run(sql)).rows);
        const got = orderedRows((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('sorts across partitions rather than returning one partition in arrival order', async () => {
      const sql = 'SELECT id FROM SALES ORDER BY val DESC, id ASC LIMIT 8';
      const ids = (await coord.distributed.coordinator.execute(sql)).rows.map(r => Number(r.id));
      expect(new Set(ids.map(id => id % 3)).size).toBeGreaterThan(1);
      expect(ids).not.toEqual([...ids].sort((a, b) => a - b));
    });

    it('projects only the requested columns even though the sort key crossed the exchange', async () => {
      const rows = (await coord.distributed.coordinator.execute('SELECT id FROM SALES ORDER BY val DESC, id ASC LIMIT 4')).rows;
      for (const row of rows) expect(Object.keys(row).map(k => k.toUpperCase())).toEqual(['ID']);
    });
  });

  describe('DISTINCT is globalised across partitions', () => {
    const distinctCases = [
      'SELECT COUNT(*) AS c FROM (SELECT DISTINCT val FROM SALES) X',
      'SELECT COUNT(*) AS c FROM (SELECT DISTINCT cat FROM SALES) X',
      'SELECT COUNT(*) AS c FROM (SELECT DISTINCT val, cat FROM SALES) X',
      'SELECT SUM(v) AS s, MIN(v) AS mn, MAX(v) AS mx FROM (SELECT DISTINCT val AS v FROM SALES) X',
      'SELECT COUNT(*) AS c FROM (SELECT DISTINCT val FROM SALES WHERE id < 100) X',
      'SELECT c AS g, COUNT(*) AS n FROM (SELECT DISTINCT cat AS c, val FROM SALES) X GROUP BY c',
      'SELECT DISTINCT val, cat FROM SALES',
      'SELECT DISTINCT val % 5 AS m, cat FROM SALES',
    ];
    for (const sql of distinctCases) {
      it(`matches single-node: ${sql.slice(0, 52)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    const orderedDistinct = [
      'SELECT DISTINCT val FROM SALES ORDER BY val ASC',
      'SELECT DISTINCT val FROM SALES ORDER BY val DESC LIMIT 7',
      'SELECT DISTINCT val FROM SALES ORDER BY val ASC LIMIT 5 OFFSET 3',
      'SELECT DISTINCT val, cat FROM SALES ORDER BY val ASC, cat ASC LIMIT 20',
    ];
    for (const sql of orderedDistinct) {
      it(`order-sensitive matches single-node: ${sql.slice(0, 46)}...`, async () => {
        const norm = rows => rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])));
        const expected = norm((await oracle.run(sql)).rows);
        const got = norm((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('dedupes once globally, not once per partition', async () => {
      const nested = (await coord.distributed.coordinator.execute('SELECT COUNT(*) AS c FROM (SELECT DISTINCT val FROM SALES) X')).rows;
      const single = (await oracle.run('SELECT COUNT(*) AS c FROM (SELECT DISTINCT val FROM SALES) X')).rows;
      expect(Number(nested[0].c)).toBe(Number(single[0].c));
      expect(Number(nested[0].c)).toBeLessThan(Number(single[0].c) * 3);
    });

    it('feeds an aggregate the globally distinct rows', async () => {
      const sql = 'SELECT SUM(v) AS s FROM (SELECT DISTINCT val AS v FROM SALES) X';
      const got = (await coord.distributed.coordinator.execute(sql)).rows;
      const expected = (await oracle.run(sql)).rows;
      expect(Number(got[0].s)).toBe(Number(expected[0].s));
    });
  });
  describe('set operations are globalised across partitions', () => {
    const setOpCases = [
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES UNION SELECT val AS v FROM SALES) X',
      'SELECT COUNT(*) AS c FROM (SELECT cat AS g FROM SALES UNION SELECT cat AS g FROM SALES) X',
      'SELECT COUNT(*) AS c FROM (SELECT id AS k, val AS v FROM SALES UNION SELECT id AS k, val AS v FROM SALES) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id < 60 UNION SELECT val AS v FROM SALES WHERE id > 150) X',
      'SELECT SUM(v) AS s, MIN(v) AS mn, MAX(v) AS mx FROM (SELECT val AS v FROM SALES UNION SELECT val AS v FROM SALES) X',
      'SELECT g AS gg, COUNT(*) AS n FROM (SELECT cat AS g FROM SALES UNION SELECT cat AS g FROM SALES) X GROUP BY g',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id < 40 UNION SELECT val AS v FROM SALES WHERE id > 160 UNION SELECT val AS v FROM SALES WHERE id BETWEEN 80 AND 90) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id > 999 UNION SELECT val AS v FROM SALES WHERE id > 999) X',
      'SELECT COUNT(*) AS c FROM (SELECT t.val AS v FROM SALES t JOIN SALES d ON t.id = d.id UNION SELECT val AS v FROM SALES) X',
    ];
    for (const sql of setOpCases) {
      it(`matches single-node: ${sql.slice(0, 56)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    const unionAllCases = [
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES UNION ALL SELECT val AS v FROM SALES) X',
      'SELECT SUM(v) AS s FROM (SELECT val AS v FROM SALES UNION ALL SELECT val AS v FROM SALES WHERE id < 50) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id < 40 UNION ALL SELECT val AS v FROM SALES WHERE id > 160 UNION SELECT val AS v FROM SALES WHERE id BETWEEN 80 AND 90) X',
    ];
    for (const sql of unionAllCases) {
      it(`keeps duplicates for UNION ALL: ${sql.slice(0, 50)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    // rows that must be matched sit on different workers here: ids 1,2,3 and 51,52,53 carry the
    // same values but land on different partitions, so a per-partition INTERSECT/EXCEPT is wrong.
    const crossPartitionMatching = [
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id IN (1,2,3) INTERSECT SELECT val AS v FROM SALES WHERE id IN (51,52,53)) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id IN (1,2,3) EXCEPT SELECT val AS v FROM SALES WHERE id IN (51,52,53)) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id IN (1,2,3) INTERSECT ALL SELECT val AS v FROM SALES WHERE id IN (51,52,53)) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id IN (1,2,3) EXCEPT ALL SELECT val AS v FROM SALES WHERE id IN (51,52,53)) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES WHERE id < 60 EXCEPT SELECT val AS v FROM SALES WHERE id > 150) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES EXCEPT ALL SELECT val AS v FROM SALES WHERE id < 100) X',
    ];
    for (const sql of crossPartitionMatching) {
      it(`matches rows across workers: ${sql.slice(0, 56)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    const orderedSetOps = [
      'SELECT v FROM (SELECT val AS v FROM SALES UNION SELECT val AS v FROM SALES) X ORDER BY v ASC',
      'SELECT v FROM (SELECT val AS v FROM SALES UNION SELECT val AS v FROM SALES) X ORDER BY v DESC LIMIT 9',
      'SELECT v FROM (SELECT val AS v FROM SALES UNION SELECT val AS v FROM SALES) X ORDER BY v ASC LIMIT 6 OFFSET 11',
      'SELECT k, v FROM (SELECT id AS k, val AS v FROM SALES WHERE id < 30 UNION SELECT id AS k, val AS v FROM SALES WHERE id > 180) X ORDER BY k ASC',
      'SELECT v FROM (SELECT val AS v FROM SALES UNION ALL SELECT val AS v FROM SALES) X ORDER BY v ASC LIMIT 11 OFFSET 4',
    ];
    for (const sql of orderedSetOps) {
      it(`order-sensitive matches single-node: ${sql.slice(0, 50)}...`, async () => {
        const norm = rows => rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])));
        const expected = norm((await oracle.run(sql)).rows);
        const got = norm((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('dedupes a UNION once globally, not once per partition', async () => {
      const sql = 'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES UNION SELECT val AS v FROM SALES) X';
      const got = (await coord.distributed.coordinator.execute(sql)).rows;
      const single = (await oracle.run(sql)).rows;
      expect(Number(got[0].c)).toBe(Number(single[0].c));
      expect(Number(got[0].c)).toBeLessThan(Number(single[0].c) * 3);
    });

    it('keeps a value whose INTERSECT partner lives on another worker', async () => {
      const sql = 'SELECT v FROM (SELECT val AS v FROM SALES WHERE id IN (1,2,3) INTERSECT SELECT val AS v FROM SALES WHERE id IN (51,52,53)) X';
      const got = (await coord.distributed.coordinator.execute(sql)).rows.map(r => Number(r.v));
      expect(got.sort((a, b) => a - b)).toEqual([7, 14, 21]);
    });

    it('drops a value whose EXCEPT match lives on another worker', async () => {
      const sql = 'SELECT v FROM (SELECT val AS v FROM SALES WHERE id IN (1,2,3) EXCEPT SELECT val AS v FROM SALES WHERE id IN (51,52,53)) X';
      const got = (await coord.distributed.coordinator.execute(sql)).rows;
      expect(got).toEqual([]);
    });
  });
  describe('CTEs distribute instead of failing or running on the coordinator', () => {
    const cteCases = [
      'WITH D AS (SELECT DISTINCT val AS v FROM SALES) SELECT COUNT(*) AS c FROM D',
      'WITH D AS (SELECT DISTINCT val AS v FROM SALES) SELECT SUM(v) AS s FROM D',
      'WITH D AS (SELECT val AS v FROM SALES WHERE id < 50) SELECT COUNT(*) AS c, SUM(v) AS s FROM D',
      'WITH D AS (SELECT id AS k, val AS v FROM SALES) SELECT COUNT(*) AS c FROM D WHERE D.v > 25',
      'WITH D AS (SELECT cat AS g, val AS v FROM SALES) SELECT g, COUNT(*) AS n FROM D GROUP BY g',
      'WITH D AS (SELECT val AS v FROM SALES) SELECT COUNT(*) AS c FROM D X',
      'WITH D AS (SELECT val AS v FROM SALES WHERE id < 60), E AS (SELECT val AS v FROM SALES WHERE id > 150) SELECT COUNT(*) AS c FROM (SELECT v FROM D UNION SELECT v FROM E) X',
      'WITH D AS (SELECT val AS v FROM SALES) SELECT COUNT(*) AS c FROM D a JOIN D b ON a.v = b.v',
      'WITH D AS (SELECT id AS k FROM SALES WHERE id < 20) SELECT COUNT(*) AS c FROM SALES s JOIN D ON s.id = D.k',
    ];
    for (const sql of cteCases) {
      it(`matches single-node: ${sql.slice(0, 56)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    const orderedCteCases = [
      'WITH D AS (SELECT id AS k, val AS v FROM SALES) SELECT k, v FROM D ORDER BY v DESC, k ASC LIMIT 8',
      'WITH D AS (SELECT DISTINCT cat AS g FROM SALES) SELECT g FROM D ORDER BY g ASC',
      'WITH D AS (SELECT id AS k FROM SALES) SELECT k FROM D ORDER BY k ASC LIMIT 7 OFFSET 5',
    ];
    for (const sql of orderedCteCases) {
      it(`order-sensitive matches single-node: ${sql.slice(0, 50)}...`, async () => {
        const norm = rows => rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])));
        const expected = norm((await oracle.run(sql)).rows);
        const got = norm((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('reads the CTE body from the workers, not the empty copy on the coordinator', async () => {
      const sql = 'WITH D AS (SELECT val AS v FROM SALES) SELECT COUNT(*) AS c FROM D';
      const rows = (await coord.distributed.coordinator.execute(sql)).rows;
      expect(Number(rows[0].c)).toBe(200);
    });
  });
  describe('aliased derived tables keep their alias across the exchange', () => {
    const aliasedCases = [
      'SELECT COUNT(*) AS c, SUM(a.v) AS s FROM (SELECT id AS k, val AS v FROM SALES) a JOIN (SELECT id AS k, val AS v FROM SALES) b ON a.k = b.k WHERE a.v > 40',
      'SELECT COUNT(*) AS c, SUM(b.v) AS s FROM (SELECT id AS k, val AS v FROM SALES) a JOIN (SELECT id AS k, val AS v FROM SALES) b ON a.k = b.k WHERE b.v > 40',
      'WITH D AS (SELECT id AS k, val AS v FROM SALES) SELECT COUNT(*) AS c, SUM(a.v) AS s FROM D a JOIN D b ON a.k = b.k WHERE a.v > 40',
      'WITH D AS (SELECT id AS k, val AS v FROM SALES) SELECT COUNT(*) AS c FROM D a JOIN D b ON a.v = b.v AND a.k <> b.k',
    ];
    for (const sql of aliasedCases) {
      it(`matches single-node: ${sql.slice(0, 56)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    const orderedAliasedCases = [
      'SELECT a.k AS ak, b.v AS bv FROM (SELECT id AS k, val AS v FROM SALES WHERE id < 30) a JOIN (SELECT id AS k, val AS v FROM SALES WHERE id < 30) b ON a.k = b.k ORDER BY ak ASC',
      'WITH D AS (SELECT id AS k, val AS v FROM SALES WHERE id < 30) SELECT a.k AS ak, b.v AS bv FROM D a JOIN D b ON a.k = b.k ORDER BY ak ASC',
    ];
    for (const sql of orderedAliasedCases) {
      it(`order-sensitive matches single-node: ${sql.slice(0, 50)}...`, async () => {
        const norm = rows => rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])));
        const expected = norm((await oracle.run(sql)).rows);
        const got = norm((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('resolves a column through the far side alias rather than yielding null', async () => {
      const sql = 'SELECT b.v AS bv FROM (SELECT id AS k, val AS v FROM SALES WHERE id < 10) a JOIN (SELECT id AS k, val AS v FROM SALES WHERE id < 10) b ON a.k = b.k';
      const rows = (await coord.distributed.coordinator.execute(sql)).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(r => r.bv !== null)).toBe(true);
    });
  });
  describe('LIMIT is applied once globally, not once per partition', () => {
    const nestedLimitCases = [
      'SELECT COUNT(*) AS c FROM (SELECT id FROM SALES LIMIT 5) X',
      'SELECT COUNT(*) AS c FROM (SELECT id FROM SALES LIMIT 1) X',
      'SELECT COUNT(*) AS c FROM (SELECT id FROM SALES LIMIT 5 OFFSET 3) X',
      'SELECT COUNT(*) AS c FROM (SELECT id FROM SALES LIMIT 500) X',
      'SELECT COUNT(*) AS c FROM (SELECT id FROM SALES ORDER BY id ASC LIMIT 40 OFFSET 10) X',
      'SELECT COUNT(*) AS c FROM (SELECT id FROM SALES ORDER BY val DESC, id ASC LIMIT 7) X',
      'SELECT SUM(id) AS s FROM (SELECT id FROM SALES ORDER BY id ASC LIMIT 10) X',
      'SELECT SUM(v) AS s FROM (SELECT val AS v FROM SALES ORDER BY val DESC, id ASC LIMIT 6) X',
      'SELECT MAX(k) AS m FROM (SELECT id AS k FROM SALES ORDER BY id ASC LIMIT 10) X',
      'SELECT COUNT(*) AS c FROM (SELECT id FROM SALES WHERE val > 25 ORDER BY id ASC LIMIT 12) X',
      'SELECT COUNT(*) AS c FROM (SELECT DISTINCT val FROM SALES ORDER BY val ASC LIMIT 9) X',
      'SELECT COUNT(*) AS c FROM (SELECT v FROM (SELECT val AS v FROM SALES ORDER BY val ASC, id ASC LIMIT 20) Y ORDER BY v ASC LIMIT 8) X',
    ];
    for (const sql of nestedLimitCases) {
      it(`matches single-node: ${sql.slice(0, 56)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    const groupByOnlyCases = [
      'SELECT COUNT(*) AS c FROM (SELECT cat FROM SALES GROUP BY cat) X',
      'SELECT COUNT(*) AS c FROM (SELECT val FROM SALES GROUP BY val) X',
      'SELECT COUNT(*) AS c FROM (SELECT cat, val FROM SALES GROUP BY cat, val) X',
      'SELECT COUNT(*) AS c FROM (SELECT cat FROM SALES GROUP BY cat ORDER BY cat) X',
      'SELECT SUM(val) AS s FROM (SELECT val FROM SALES GROUP BY val) X',
    ];
    for (const sql of groupByOnlyCases) {
      it(`groups once across workers without an aggregate: ${sql.slice(0, 46)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    const wholeInputCases = [
      'SELECT SUM(w) AS s FROM (SELECT COUNT(*) OVER () AS w FROM SALES) Y',
      'SELECT SUM(w) AS s FROM (SELECT COUNT(*) OVER () AS w FROM SALES WHERE val > 10) Y',
      'SELECT MAX(w) AS m FROM (SELECT ROW_NUMBER() OVER (ORDER BY id) AS w FROM SALES) Y',
      'SELECT MAX(w) AS m FROM (SELECT RANK() OVER (ORDER BY val) AS w FROM SALES) Y',
      'SELECT COUNT(w) AS c FROM (SELECT LAG(val) OVER (ORDER BY id) AS w FROM SALES) Y',
      'SELECT SUM(w) AS s FROM (SELECT SUM(val) OVER (PARTITION BY cat) AS w FROM SALES) Y',
      'SELECT SUM(c) AS s FROM (SELECT COUNT(DISTINCT val) AS c FROM SALES) X',
      'SELECT SUM(c) AS s FROM (SELECT cat AS g, COUNT(DISTINCT val) AS c FROM SALES GROUP BY cat) X',
    ];
    for (const sql of wholeInputCases) {
      it(`gives an operator that needs every row its whole input: ${sql.slice(0, 44)}...`, async () => {
        const expected = canon((await oracle.run(sql)).rows);
        const got = canon((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('counts the limited rows once, not once per worker', async () => {
      const rows = (await coord.distributed.coordinator.execute('SELECT COUNT(*) AS c FROM (SELECT id FROM SALES LIMIT 5) X')).rows;
      expect(Number(rows[0].c)).toBe(5);
    });

    // the local TopN now sits under the exchange, so its output schema has to survive the gather
    // for the coordinator's re-ranking comparator to resolve its keys
    const computedSortKeyCases = [
      'SELECT id FROM SALES ORDER BY CASE WHEN cat IS NULL THEN 0 ELSE 1 END ASC, id ASC LIMIT 25',
      'SELECT id, cat FROM SALES ORDER BY UPPER(cat) ASC, id ASC LIMIT 20',
      'SELECT id FROM SALES ORDER BY val % 7 ASC, id ASC LIMIT 25',
      'SELECT id, val FROM SALES ORDER BY val * -1 ASC, id ASC LIMIT 15',
    ];
    for (const sql of computedSortKeyCases) {
      it(`order-sensitive matches single-node: ${sql.slice(0, 50)}...`, async () => {
        const norm = rows => rows.map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])));
        const expected = norm((await oracle.run(sql)).rows);
        const got = norm((await coord.distributed.coordinator.execute(sql)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('keeps a top-level LIMIT to the requested number of real rows', async () => {
      const rows = (await coord.distributed.coordinator.execute('SELECT id FROM SALES LIMIT 5')).rows;
      const all = new Set((await oracle.run('SELECT id FROM SALES')).rows.map(r => Number(r.id)));
      expect(rows).toHaveLength(5);
      for (const row of rows) expect(all.has(Number(row.id))).toBe(true);
    });
  });
  describe('several queries in flight at once', () => {
    const concurrentCases = [
      'SELECT COUNT(*) AS c FROM SALES',
      'SELECT cat AS g, COUNT(*) AS c, SUM(val) AS s FROM SALES GROUP BY cat',
      'SELECT COUNT(*) AS c FROM (SELECT DISTINCT val FROM SALES) X',
      'SELECT COUNT(*) AS c FROM (SELECT id FROM SALES LIMIT 7) X',
      'SELECT COUNT(*) AS c FROM (SELECT val AS v FROM SALES UNION SELECT val AS v FROM SALES) X',
      'WITH D AS (SELECT val AS v FROM SALES) SELECT COUNT(*) AS c, SUM(v) AS s FROM D',
      'SELECT COUNT(*) AS c, SUM(t.val) AS s FROM SALES t JOIN SALES d ON t.cat = d.cat',
      'SELECT id, SUM(val) OVER (PARTITION BY cat) AS w FROM SALES',
    ];

    it('gives every concurrent query the same answer it gets alone', async () => {
      const expected = new Map();
      for (const sql of concurrentCases) expected.set(sql, canon((await oracle.run(sql)).rows));

      const results = await Promise.all(concurrentCases.map(sql =>
        coord.distributed.coordinator.execute(sql).then(r => [sql, canon(r.rows)])));

      for (const [sql, got] of results) expect(got).toEqual(expected.get(sql));
    });

    it('stays correct when the same query overlaps itself', async () => {
      const sql = 'SELECT cat AS g, COUNT(*) AS c FROM SALES GROUP BY cat';
      const expected = canon((await oracle.run(sql)).rows);

      const results = await Promise.all(Array.from({ length: 6 }, () =>
        coord.distributed.coordinator.execute(sql).then(r => canon(r.rows))));

      for (const got of results) expect(got).toEqual(expected);
    });

    it('leaves no exchange listeners behind once the queries finish', async () => {
      await Promise.all(concurrentCases.map(sql => coord.distributed.coordinator.execute(sql)));

      for (const node of [coord, w1, w2, w3]) {
        expect(node.distributed.transport._chunkListeners.size).toBe(0);
      }
    });
  });
  describe('CREATE TABLE AS SELECT reads through the cluster', () => {
    const ctasCases = [
      ['CT1', 'SELECT id, val FROM SALES WHERE val > 25'],
      ['CT2', 'SELECT cat AS g, COUNT(*) AS n, SUM(val) AS s FROM SALES GROUP BY cat'],
      ['CT3', 'SELECT DISTINCT val AS v FROM SALES'],
      ['CT4', 'SELECT id FROM SALES ORDER BY val DESC, id ASC LIMIT 15'],
      ['CT5', 'SELECT v FROM (SELECT val AS v FROM SALES UNION SELECT val AS v FROM SALES) X'],
      ['CT6', 'SELECT id, val FROM SALES WHERE id > 100000'],
    ];
    for (const [name, select] of ctasCases) {
      it(`fills ${name} from the workers: ${select.slice(0, 44)}...`, async () => {
        await coord.distributed.coordinator.execute(`CREATE TABLE ${name} AS ${select}`);

        const expected = canon((await oracle.run(select)).rows);
        const got = canon((await coord.distributed.coordinator.execute(`SELECT * FROM ${name}`)).rows);
        expect(got).toEqual(expected);
      });
    }

    it('reports the row count it actually wrote', async () => {
      const result = await coord.distributed.coordinator.execute('CREATE TABLE CT7 AS SELECT id FROM SALES WHERE val > 25');
      const expected = (await oracle.run('SELECT COUNT(*) AS c FROM SALES WHERE val > 25')).rows[0].c;
      expect(result.message).toContain(`${Number(expected)} rows`);
    });

    it('leaves a table created from a partitioned source usable as a source itself', async () => {
      await coord.distributed.coordinator.execute('CREATE TABLE CT8 AS SELECT id, val FROM SALES WHERE val > 25');

      const got = (await coord.distributed.coordinator.execute('SELECT COUNT(*) AS n FROM CT8 JOIN SALES ON CT8.id = SALES.id')).rows;
      const expected = (await oracle.run('SELECT COUNT(*) AS n FROM SALES x JOIN SALES y ON x.id = y.id WHERE x.val > 25')).rows;
      expect(Number(got[0].n)).toBe(Number(expected[0].n));
    });

    it('replaces the contents when a table is dropped and recreated', async () => {
      await coord.distributed.coordinator.execute('CREATE TABLE CT9 AS SELECT id FROM SALES WHERE id <= 10');
      const first = (await coord.distributed.coordinator.execute('SELECT COUNT(*) AS c FROM CT9')).rows;
      await coord.distributed.coordinator.execute('DROP TABLE CT9');
      await coord.distributed.coordinator.execute('CREATE TABLE CT9 AS SELECT id FROM SALES WHERE id <= 25');
      const second = (await coord.distributed.coordinator.execute('SELECT COUNT(*) AS c FROM CT9')).rows;

      expect(Number(first[0].c)).toBe(10);
      expect(Number(second[0].c)).toBe(25);
    });

    it('still handles DDL that has no query behind it', async () => {
      await coord.distributed.coordinator.execute('CREATE TABLE CT10 (A INTEGER, B VARCHAR)');
      expect(Number((await coord.distributed.coordinator.execute('SELECT COUNT(*) AS c FROM CT10')).rows[0].c)).toBe(0);

      await coord.distributed.coordinator.execute('DROP TABLE CT10');
      await expect(coord.distributed.coordinator.execute('SELECT COUNT(*) AS c FROM CT10')).rejects.toThrow();
    });
  });
});
