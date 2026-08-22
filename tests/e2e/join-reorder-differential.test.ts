import { describe, it, expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { PlanNodeType, JoinType } from '../../src/planner/logical-plan.js';
import { seededRandom } from '../helpers/join-graphs.js';

const CUSTOMERS = [
  { ID: 1, NAME: 'ann', REGION: 'north' },
  { ID: 2, NAME: 'bob', REGION: 'south' },
  { ID: 3, NAME: 'cal', REGION: 'north' },
  { ID: 4, NAME: 'dee', REGION: null },
  { ID: 5, NAME: 'eve', REGION: 'south' },
];

const ORDERS = [
  { ID: 10, CUST: 1, AMOUNT: 100, SHIPPER: 1 },
  { ID: 11, CUST: 1, AMOUNT: 250, SHIPPER: 2 },
  { ID: 12, CUST: 2, AMOUNT: 75, SHIPPER: null },
  { ID: 13, CUST: 3, AMOUNT: null, SHIPPER: 1 },
  { ID: 14, CUST: 9, AMOUNT: 400, SHIPPER: 3 },
  { ID: 15, CUST: null, AMOUNT: 50, SHIPPER: 2 },
];

const SHIPPERS = [
  { ID: 1, CARRIER: 'air' },
  { ID: 2, CARRIER: 'sea' },
  { ID: 4, CARRIER: 'rail' },
];

const REGIONS = [
  { NAME: 'north', ZONE: 'A' },
  { NAME: 'south', ZONE: 'B' },
  { NAME: 'west', ZONE: 'C' },
];

const RETURNS = [
  { ORDER_ID: 11, REASON: 'damaged' },
  { ORDER_ID: 14, REASON: 'late' },
];

const CORPUS = [
  `SELECT C.NAME, O.AMOUNT FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST`,
  `SELECT C.NAME, O.AMOUNT, S.CARRIER FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST JOIN SHIPPERS S ON S.ID = O.SHIPPER`,
  `SELECT C.NAME, O.AMOUNT, R.ZONE FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST JOIN REGIONS R ON R.NAME = C.REGION`,
  `SELECT C.NAME, O.AMOUNT, R.ZONE FROM CUSTOMERS C JOIN REGIONS R ON R.NAME = C.REGION LEFT JOIN ORDERS O ON C.ID = O.CUST`,
  `SELECT C.NAME, O.AMOUNT, S.CARRIER FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST LEFT JOIN SHIPPERS S ON S.ID = O.SHIPPER`,
  `SELECT C.NAME, S.CARRIER FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST LEFT JOIN SHIPPERS S ON S.ID = O.SHIPPER WHERE C.REGION IS NOT NULL`,
  `SELECT C.NAME, O.AMOUNT, S.CARRIER, R.ZONE FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST LEFT JOIN SHIPPERS S ON S.ID = O.SHIPPER JOIN REGIONS R ON R.NAME = C.REGION`,
  `SELECT C.NAME, O.AMOUNT FROM ORDERS O RIGHT JOIN CUSTOMERS C ON C.ID = O.CUST`,
  `SELECT C.NAME, O.AMOUNT FROM CUSTOMERS C FULL OUTER JOIN ORDERS O ON C.ID = O.CUST`,
  `SELECT C.NAME, O.AMOUNT, S.CARRIER FROM CUSTOMERS C FULL OUTER JOIN ORDERS O ON C.ID = O.CUST LEFT JOIN SHIPPERS S ON S.ID = O.SHIPPER`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE NOT EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME, R.ZONE FROM CUSTOMERS C JOIN REGIONS R ON R.NAME = C.REGION WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME, R.ZONE FROM CUSTOMERS C JOIN REGIONS R ON R.NAME = C.REGION WHERE NOT EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME, O.AMOUNT FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST WHERE EXISTS (SELECT 1 FROM REGIONS R WHERE R.NAME = C.REGION)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.ID IN (SELECT O.CUST FROM ORDERS O)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.ID NOT IN (SELECT O.CUST FROM ORDERS O WHERE O.CUST IS NOT NULL)`,
  `SELECT C.NAME, O.ID FROM CUSTOMERS C JOIN ORDERS O ON C.ID = O.CUST WHERE O.ID IN (SELECT T.ORDER_ID FROM RETURNS T)`,
  `SELECT C.NAME, O.ID FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST LEFT JOIN RETURNS T ON T.ORDER_ID = O.ID`,
  `SELECT C.NAME, O.ID, T.REASON FROM CUSTOMERS C JOIN ORDERS O ON C.ID = O.CUST LEFT JOIN RETURNS T ON T.ORDER_ID = O.ID JOIN REGIONS R ON R.NAME = C.REGION`,
  `SELECT C.NAME, O.ID, T.REASON, S.CARRIER FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST LEFT JOIN RETURNS T ON T.ORDER_ID = O.ID LEFT JOIN SHIPPERS S ON S.ID = O.SHIPPER`,
  `SELECT R.ZONE, COUNT(*) AS N FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST JOIN REGIONS R ON R.NAME = C.REGION GROUP BY R.ZONE`,
  `SELECT C.NAME, SUM(O.AMOUNT) AS TOTAL FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST GROUP BY C.NAME`,
  `SELECT C.NAME, O.AMOUNT FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST AND O.AMOUNT > 80`,
  `SELECT C.NAME, O.AMOUNT FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST WHERE O.AMOUNT IS NULL`,
  `SELECT C.NAME, O.AMOUNT, S.CARRIER FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST LEFT JOIN SHIPPERS S ON S.ID = O.SHIPPER WHERE S.CARRIER IS NULL`,
  `SELECT C.NAME, O.AMOUNT FROM CUSTOMERS C JOIN ORDERS O ON C.ID = O.CUST JOIN SHIPPERS S ON S.ID = O.SHIPPER JOIN REGIONS R ON R.NAME = C.REGION`,
  `SELECT C.NAME, X.AMOUNT FROM CUSTOMERS C LEFT JOIN (SELECT O.CUST AS CUST, O.AMOUNT AS AMOUNT FROM ORDERS O WHERE O.AMOUNT > 60) X ON X.CUST = C.ID`,
  `SELECT C.NAME, O.AMOUNT FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST ORDER BY C.NAME, O.AMOUNT`,
  `SELECT C.NAME, O.ID FROM CUSTOMERS C LEFT JOIN ORDERS O ON C.ID = O.CUST WHERE C.ID IN (SELECT R2.CUST FROM ORDERS R2 WHERE R2.AMOUNT > 90)`,
];

function seed(engine) {
  registerTable(engine, 'CUSTOMERS', CUSTOMERS);
  registerTable(engine, 'ORDERS', ORDERS);
  registerTable(engine, 'SHIPPERS', SHIPPERS);
  registerTable(engine, 'REGIONS', REGIONS);
  registerTable(engine, 'RETURNS', RETURNS);
}

function withoutJoinReorder() {
  const engine = createEngine();
  const build = engine.createOptimizer.bind(engine);
  engine.createOptimizer = statistics => build(statistics).removePass('JoinReorder');
  engine.optimizer = engine.createOptimizer(engine.precomputedStats);
  seed(engine);
  return engine;
}

function withJoinReorder() {
  const engine = createEngine();
  seed(engine);
  return engine;
}

function normalize(rows) {
  return rows.map(row => JSON.stringify(row)).sort();
}

function collectJoins(node, found = []) {
  if (!node) return found;
  if (node.type === PlanNodeType.JOIN) found.push(node);
  for (const child of node.children || []) collectJoins(child, found);
  return found;
}

async function logicalPlanFor(engine, sql) {
  const bound = engine.bind(engine.parseSQL(sql));
  await engine.run(`SELECT COUNT(*) AS N FROM CUSTOMERS`);
  return engine.optimizer.optimize(engine.plan(bound), {});
}

describe('JoinReorder is result preserving across outer, semi and anti joins', () => {
  it('covers outer, semi, anti and full joins in the corpus', () => {
    expect(CORPUS.some(sql => sql.includes('LEFT JOIN'))).toBe(true);
    expect(CORPUS.some(sql => sql.includes('FULL OUTER JOIN'))).toBe(true);
    expect(CORPUS.some(sql => sql.includes('RIGHT JOIN'))).toBe(true);
    expect(CORPUS.some(sql => sql.includes('NOT EXISTS'))).toBe(true);
    expect(CORPUS.some(sql => sql.includes('NOT IN'))).toBe(true);
  });

  for (const sql of CORPUS) {
    it(`matches the unoptimized join order: ${sql.slice(0, 72)}`, async () => {
      const optimized = withJoinReorder();
      const plain = withoutJoinReorder();

      const optimizedRows = (await optimized.run(sql)).rows;
      const plainRows = (await plain.run(sql)).rows;

      optimized.close();
      plain.close();

      expect(normalize(optimizedRows)).toEqual(normalize(plainRows));
      expect(plainRows.length).toBeGreaterThan(0);
    });
  }

  it('removes JoinReorder from the comparison engine even after statistics are collected', async () => {
    const plain = withoutJoinReorder();
    await plain.run(`SELECT COUNT(*) AS N FROM CUSTOMERS`);

    expect(plain.optimizer.listPasses()).not.toContain('JoinReorder');
    plain.close();
  });
});

describe('JoinReorder changes the join order for mixed outer and inner blocks', () => {
  it('reshapes at least one outer-join query in the corpus', async () => {
    const optimized = withJoinReorder();
    const plain = withoutJoinReorder();
    const sql = CORPUS[2];

    const optimizedPlan = await logicalPlanFor(optimized, sql);
    const plainPlan = await logicalPlanFor(plain, sql);

    const optimizedShape = collectJoins(optimizedPlan).map(join => join.joinType);
    const plainShape = collectJoins(plainPlan).map(join => join.joinType);

    optimized.close();
    plain.close();

    expect(plainShape).toContain(JoinType.LEFT);
    expect(optimizedShape).toContain(JoinType.LEFT);
    expect(optimizedShape).not.toEqual(plainShape);
  });
});

const JOIN_GRAPH = {
  C: { table: 'CUSTOMERS', links: { O: 'C.ID = O.CUST', R: 'C.REGION = R.NAME' } },
  O: { table: 'ORDERS', links: { C: 'C.ID = O.CUST', S: 'O.SHIPPER = S.ID', T: 'O.ID = T.ORDER_ID' } },
  S: { table: 'SHIPPERS', links: { O: 'O.SHIPPER = S.ID' } },
  R: { table: 'REGIONS', links: { C: 'C.REGION = R.NAME' } },
  T: { table: 'RETURNS', links: { O: 'O.ID = T.ORDER_ID' } },
};

const PROJECTIONS = { C: 'C.NAME', O: 'O.AMOUNT', S: 'S.CARRIER', R: 'R.ZONE', T: 'T.REASON' };

const FILTERS = {
  C: ['C.REGION IS NOT NULL', "C.NAME <> 'bob'"],
  O: ['O.AMOUNT > 80', 'O.AMOUNT IS NULL', 'O.SHIPPER IS NOT NULL'],
  S: ["S.CARRIER = 'air'", 'S.CARRIER IS NULL'],
  R: ["R.ZONE <> 'C'", 'R.ZONE IS NOT NULL'],
  T: ['T.REASON IS NOT NULL', "T.REASON = 'late'"],
};

const JOIN_KEYWORDS = ['JOIN', 'JOIN', 'LEFT JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN'];

function pick(random, items) {
  return items[Math.floor(random() * items.length) % items.length];
}

function generateQuery(random) {
  const aliases = Object.keys(JOIN_GRAPH);
  const chosen = [pick(random, aliases)];
  const width = 2 + Math.floor(random() * 4);

  while (chosen.length < width) {
    const reachable = chosen.flatMap(alias => Object.keys(JOIN_GRAPH[alias].links).filter(next => !chosen.includes(next)));
    if (reachable.length === 0) break;
    chosen.push(pick(random, reachable));
  }
  if (chosen.length < 2) return null;

  const [head, ...rest] = chosen;
  let sql = `FROM ${JOIN_GRAPH[head].table} ${head}`;
  const joined = [head];
  for (const alias of rest) {
    const anchor = pick(random, joined.filter(prev => JOIN_GRAPH[alias].links[prev]));
    sql += ` ${pick(random, JOIN_KEYWORDS)} ${JOIN_GRAPH[alias].table} ${alias} ON ${JOIN_GRAPH[alias].links[anchor]}`;
    joined.push(alias);
  }

  const conditions = [];
  if (random() < 0.5) conditions.push(pick(random, FILTERS[pick(random, chosen)]));
  if (chosen.includes('C') && !chosen.includes('O') && random() < 0.5) {
    const negated = random() < 0.5 ? 'NOT ' : '';
    conditions.push(`${negated}EXISTS (SELECT 1 FROM ORDERS O2 WHERE O2.CUST = C.ID)`);
  }
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;

  const projected = chosen.slice(0, 1 + Math.floor(random() * chosen.length));
  return `SELECT ${projected.map(alias => PROJECTIONS[alias]).join(', ')} ${sql}`;
}

describe('JoinReorder is result preserving across a generated join corpus', () => {
  const random = seededRandom(20260821);
  const generated = [];
  for (let i = 0; generated.length < 160 && i < 400; i++) {
    const sql = generateQuery(random);
    if (sql) generated.push(sql);
  }

  it('generates a corpus that exercises every join keyword', () => {
    expect(generated).toHaveLength(160);
    for (const keyword of ['LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'EXISTS']) {
      expect(generated.some(sql => sql.includes(keyword)), keyword).toBe(true);
    }
  });

  it('returns identical rows with and without JoinReorder for every generated query', async () => {
    const optimized = withJoinReorder();
    const plain = withoutJoinReorder();
    let nonEmpty = 0;

    for (const sql of generated) {
      const optimizedRows = (await optimized.run(sql)).rows;
      const plainRows = (await plain.run(sql)).rows;
      expect(normalize(optimizedRows), sql).toEqual(normalize(plainRows));
      if (plainRows.length > 0) nonEmpty++;
    }

    optimized.close();
    plain.close();

    expect(nonEmpty).toBeGreaterThan(generated.length / 2);
  });
});
