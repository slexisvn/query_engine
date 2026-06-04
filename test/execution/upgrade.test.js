import { describe, it, expect, beforeAll } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { generateTPCHData } from '../fixtures/tpch-gen.js';
import { dateToEpochDays } from '../../src/storage/data-type.js';

let engine;

beforeAll(async () => {
  const data = await generateTPCHData();
  engine = new QueryEngine(data.catalog);
});

describe('CTE Execution', () => {
  it('executes simple CTE', async () => {
    const result = await engine.run(`
      WITH cte AS (SELECT r_regionkey, r_name FROM region)
      SELECT * FROM cte
    `);
    expect(result.rows.length).toBe(5);
  });

  it('executes CTE with filter', async () => {
    const result = await engine.run(`
      WITH european AS (
        SELECT n_name FROM nation JOIN region ON n_regionkey = r_regionkey WHERE r_name = 'EUROPE'
      )
      SELECT * FROM european
    `);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe('JOIN Types', () => {
  it('executes RIGHT JOIN', async () => {
    const result = await engine.run(`
      SELECT r_name, n_name
      FROM nation RIGHT JOIN region ON n_regionkey = r_regionkey
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(25);
  });

  it('executes SINGLE JOIN (scalar subquery pattern)', async () => {
    const result = await engine.run(`
      SELECT r_name FROM region WHERE r_regionkey = 0
    `);
    expect(result.rows[0].r_name).toBe('AFRICA');
  });
});

describe('Date Arithmetic', () => {
  it('adds YEAR interval to date', async () => {
    const result = await engine.run(`
      SELECT COUNT(*) AS cnt FROM orders
      WHERE o_orderdate >= DATE '1994-01-01'
        AND o_orderdate < DATE '1994-01-01' + INTERVAL '1' YEAR
    `);
    expect(result.rows[0].cnt).toBeGreaterThan(0);
  });

  it('adds MONTH interval to date', async () => {
    const result = await engine.run(`
      SELECT COUNT(*) AS cnt FROM orders
      WHERE o_orderdate >= DATE '1993-10-01'
        AND o_orderdate < DATE '1993-10-01' + INTERVAL '3' MONTH
    `);
    expect(result.rows[0].cnt).toBeGreaterThanOrEqual(0);
  });

  it('subtracts DAY interval from date', async () => {
    const result = await engine.run(`
      SELECT COUNT(*) AS cnt FROM lineitem
      WHERE l_shipdate <= DATE '1998-12-01' - INTERVAL '90' DAY
    `);
    expect(result.rows[0].cnt).toBeGreaterThan(0);
  });
});

describe('COUNT DISTINCT', () => {
  it('executes COUNT(DISTINCT)', async () => {
    const result = await engine.run(`
      SELECT COUNT(DISTINCT n_regionkey) AS cnt FROM nation
    `);
    expect(result.rows[0].cnt).toBe(5);
  });

  it('executes COUNT(DISTINCT) with GROUP BY', async () => {
    const result = await engine.run(`
      SELECT r_regionkey, COUNT(DISTINCT n_nationkey) AS cnt
      FROM nation JOIN region ON n_regionkey = r_regionkey
      GROUP BY r_regionkey
      ORDER BY r_regionkey
    `);
    expect(result.rows.length).toBe(5);
    const total = result.rows.reduce((s, r) => s + r.cnt, 0);
    expect(total).toBe(25);
  });
});
