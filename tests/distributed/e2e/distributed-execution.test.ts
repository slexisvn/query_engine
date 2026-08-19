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
});
