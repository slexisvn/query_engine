import { describe, it, expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';

const CUSTOMERS = [
  { ID: 1, NAME: 'ann', REGION: 'north', TIER: 1 },
  { ID: 2, NAME: 'bob', REGION: 'south', TIER: 2 },
  { ID: 3, NAME: 'cal', REGION: 'north', TIER: null },
  { ID: 4, NAME: 'dee', REGION: null, TIER: 2 },
  { ID: 5, NAME: 'eve', REGION: 'south', TIER: 3 },
];

const ORDERS = [
  { ID: 10, CUST: 1, AMOUNT: 100, SHIPPER: 1 },
  { ID: 11, CUST: 1, AMOUNT: 250, SHIPPER: 2 },
  { ID: 12, CUST: 2, AMOUNT: 75, SHIPPER: null },
  { ID: 13, CUST: 3, AMOUNT: null, SHIPPER: 1 },
  { ID: 14, CUST: 9, AMOUNT: 400, SHIPPER: 3 },
  { ID: 15, CUST: null, AMOUNT: 50, SHIPPER: 2 },
  { ID: 16, CUST: 2, AMOUNT: 250, SHIPPER: 1 },
];

const SHIPPERS = [
  { ID: 1, CARRIER: 'air' },
  { ID: 2, CARRIER: 'sea' },
  { ID: 4, CARRIER: 'rail' },
];

const RETURNS = [
  { ORDER_ID: 11, REASON: 'damaged' },
  { ORDER_ID: 14, REASON: 'late' },
];

const TABLES = { CUSTOMERS, ORDERS, SHIPPERS, RETURNS };

const CORRELATED = [
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE NOT EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.AMOUNT > C.TIER * 100)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE NOT EXISTS (SELECT 1 FROM ORDERS O WHERE O.AMOUNT > C.TIER * 100)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM ORDERS O JOIN SHIPPERS S ON S.ID = O.SHIPPER WHERE O.AMOUNT > C.TIER * 50)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.AMOUNT > C.TIER * 100 ORDER BY O.ID LIMIT 1)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.REGION IS NULL OR EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM (SELECT O.CUST AS OC FROM ORDERS O WHERE O.AMOUNT > C.TIER * 50) X WHERE X.OC = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID UNION ALL SELECT 1 FROM RETURNS T WHERE T.ORDER_ID = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER IN (SELECT O.SHIPPER FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER IN (SELECT O.SHIPPER FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER NOT IN (SELECT O.SHIPPER FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40 AND O.SHIPPER IS NOT NULL)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER IN (SELECT O.SHIPPER FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40 ORDER BY O.ID LIMIT 2)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER IN (SELECT O.SHIPPER FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40 ORDER BY O.ID LIMIT 1 OFFSET 1)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER IN (SELECT DISTINCT O.SHIPPER FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.ID IN (SELECT O.CUST FROM ORDERS O WHERE O.CUST = C.ID UNION SELECT T.ORDER_ID FROM RETURNS T WHERE T.ORDER_ID = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.ID IN (SELECT O.CUST FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40 INTERSECT SELECT O2.CUST FROM ORDERS O2)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER IN (SELECT MAX(O.SHIPPER) OVER () FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER IN (SELECT MAX(O.SHIPPER) OVER (PARTITION BY O.CUST) FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER > ANY (SELECT O.SHIPPER FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER < ALL (SELECT O.SHIPPER FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40)`,
  `SELECT C.NAME, (SELECT COUNT(*) FROM ORDERS O WHERE O.CUST = C.ID) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT SUM(O.AMOUNT) FROM ORDERS O WHERE O.CUST = C.ID) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT COUNT(*) FROM ORDERS O WHERE O.AMOUNT > C.TIER * 100) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT SUM(O.AMOUNT + C.TIER) FROM ORDERS O WHERE O.CUST = C.ID) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT O.AMOUNT FROM ORDERS O WHERE O.CUST = C.ID ORDER BY O.AMOUNT DESC LIMIT 1) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT O.AMOUNT FROM ORDERS O WHERE O.AMOUNT > C.TIER * 40 ORDER BY O.AMOUNT LIMIT 1) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT O.AMOUNT + C.TIER FROM ORDERS O WHERE O.ID = C.ID * 10) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT COUNT(O.ID) FROM SHIPPERS S LEFT JOIN ORDERS O ON O.SHIPPER = S.ID AND O.AMOUNT > C.TIER * 40 WHERE S.ID = C.TIER) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT COUNT(*) FROM ORDERS O JOIN SHIPPERS S ON S.ID = O.SHIPPER WHERE O.AMOUNT > C.TIER * 40) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME, (SELECT MAX(O.AMOUNT) FROM ORDERS O WHERE O.CUST = C.ID AND (O.AMOUNT > C.TIER * 40 OR C.TIER IS NULL)) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE (SELECT COUNT(*) FROM ORDERS O WHERE O.CUST = C.ID) > 1`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.TIER = (SELECT MIN(O.SHIPPER) FROM ORDERS O WHERE O.CUST = C.ID)`,
  `SELECT C.REGION FROM CUSTOMERS C GROUP BY C.REGION HAVING COUNT(*) > (SELECT COUNT(*) FROM CUSTOMERS X WHERE X.REGION = C.REGION AND X.TIER IS NULL)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = C.ID AND O.SHIPPER IN (SELECT S.ID FROM SHIPPERS S))`,
  `SELECT C.NAME, (SELECT COUNT(*) FROM ORDERS O WHERE O.CUST = C.ID) AS A, (SELECT SUM(O.AMOUNT) FROM ORDERS O WHERE O.CUST = C.ID) AS B FROM CUSTOMERS C`,
  `SELECT X.NAME FROM (SELECT C.NAME AS NAME, C.ID AS ID FROM CUSTOMERS C) X WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.CUST = X.ID)`,
];

const UNCORRELATED = [
  `SELECT C.NAME FROM CUSTOMERS C WHERE EXISTS (SELECT 1 FROM ORDERS O WHERE O.AMOUNT > 300)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE NOT EXISTS (SELECT 1 FROM ORDERS O WHERE O.AMOUNT > 1000)`,
  `SELECT C.NAME, (SELECT COUNT(*) FROM ORDERS O) AS N FROM CUSTOMERS C`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.ID IN (SELECT O.CUST FROM ORDERS O)`,
  `SELECT C.NAME FROM CUSTOMERS C WHERE C.ID NOT IN (SELECT O.CUST FROM ORDERS O WHERE O.CUST IS NOT NULL)`,
];

const RUNS_WITHOUT_UNNESTING = UNCORRELATED.slice(0, 3);

const CORPUS = [...CORRELATED, ...UNCORRELATED];

interface Outcome {
  rows?: string[];
  error?: string;
}

async function makeEngine(removedPass: string | null) {
  const engine = createEngine();
  for (const [name, rows] of Object.entries(TABLES)) registerTable(engine, name, rows);
  if (removedPass) {
    const base = engine.createOptimizer.bind(engine);
    engine.createOptimizer = (statistics) => base(statistics).removePass(removedPass);
    engine.optimizer = engine.createOptimizer(engine.precomputedStats);
  }
  for (const name of Object.keys(TABLES)) await engine.run(`SELECT COUNT(*) AS C FROM ${name}`);
  return engine;
}

async function runConfiguration(removedPass: string | null) {
  const engine = await makeEngine(removedPass);
  const outcomes = new Map<string, Outcome>();
  for (const sql of CORPUS) {
    try {
      const result = await engine.run(sql);
      outcomes.set(sql, { rows: result.rows.map((row) => JSON.stringify(row)).sort() });
    } catch (error) {
      outcomes.set(sql, { error: (error as Error).message });
    }
  }
  const passes: string[] = engine.optimizer.listPasses();
  engine.close();
  return { outcomes, passes };
}

describe('subquery unnesting under pass ablation', () => {
  it('answers every correlated shape the same way however the pipeline is trimmed', async () => {
    const base = await runConfiguration(null);
    const divergences: string[] = [];

    for (const pass of base.passes) {
      const trimmed = await runConfiguration(pass);
      for (const sql of CORPUS) {
        const expected = base.outcomes.get(sql)!;
        const actual = trimmed.outcomes.get(sql)!;
        if (expected.error || actual.error) continue;
        if (expected.rows!.join('') !== actual.rows!.join('')) {
          divergences.push(`without ${pass}: ${sql}\n  default: ${expected.rows!.join(' | ')}\n  trimmed: ${actual.rows!.join(' | ')}`);
        }
      }
    }

    expect(divergences).toEqual([]);
  }, 300000);

  it('answers every correlated shape without erroring under the default pipeline', async () => {
    const base = await runConfiguration(null);
    const failures = CORPUS.filter((sql) => base.outcomes.get(sql)!.error);
    expect(failures).toEqual([]);
  }, 120000);

  it('still answers the uncorrelated subqueries the dependent join can evaluate', async () => {
    const trimmed = await runConfiguration('SubqueryUnnesting');
    const base = await runConfiguration(null);

    for (const sql of RUNS_WITHOUT_UNNESTING) {
      expect(trimmed.outcomes.get(sql)).toEqual(base.outcomes.get(sql));
    }
  }, 120000);

  it('refuses to run a correlated subquery once unnesting is removed', async () => {
    const trimmed = await runConfiguration('SubqueryUnnesting');
    const correlated = CORPUS.filter((sql) => /\bC\.\w+\b[^()]*\)/.test(sql));
    const answered = correlated.filter((sql) => !trimmed.outcomes.get(sql)!.error);

    expect(answered).toEqual([]);
  }, 120000);
});
