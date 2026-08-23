import { describe, it, expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';

const LEFT = [];
const RIGHT = [];
for (let i = 0; i < 80; i++) {
  LEFT.push({ ID: i, K: i % 9, V: i, TAG: i % 3 === 0 ? null : `t${i % 4}` });
  RIGHT.push({ ID: i, K: i % 9, W: i * 3 });
}

const FIXED_STATISTICS = () => {
  const table = () => ({
    rowCount: 1000,
    columnStats: new Map(),
    getColumnStats: () => null,
    getCorrelation: () => null,
  });
  return new Map([['L', table()], ['R', table()]]);
};

const PROHIBITIVE = 1e6;

async function withEngine(preferMergeJoin, body) {
  const engine = createEngine({ statistics: FIXED_STATISTICS() });
  registerTable(engine, 'L', LEFT);
  registerTable(engine, 'R', RIGHT);
  if (preferMergeJoin) {
    engine.executor.physicalPlanner.costModel.C_HASH_INSERT = PROHIBITIVE;
  }
  try {
    return await body(engine);
  } finally {
    engine.close();
  }
}

async function planAndRun(preferMergeJoin, sql) {
  return withEngine(preferMergeJoin, async (engine) => {
    const explained = await engine.run(`EXPLAIN ${sql}`);
    const operators = explained.rows[0].EXPLAIN_PLAN
      .split('Physical Plan:')[1]
      .trim()
      .split('\n')
      .map(line => line.trim().split('(')[0]);
    return { operators, rows: (await engine.run(sql)).rows };
  });
}

const orderKeyValues = (rows, column) => rows.map(row => row[column]);
const asMultiset = (rows) => rows.map(row => JSON.stringify(row)).sort();
const isNonDecreasing = (values) => values.every((value, index) => index === 0 || values[index - 1] <= value);

describe('a merge join plan answers the same as sorting above a hash join', () => {
  const cases = [
    {
      name: 'full result ordered by the left join key',
      sql: 'SELECT l.K, l.V, r.W FROM L l JOIN R r ON l.K = r.K ORDER BY l.K',
      column: 'K',
      elided: 'Sort',
    },
    {
      name: 'full result ordered by the right join key',
      sql: 'SELECT r.K AS K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY r.K',
      column: 'K',
      elided: 'Sort',
    },
    {
      name: 'top rows by the join key',
      sql: 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.K LIMIT 17',
      column: 'K',
      elided: 'TopN',
    },
    {
      name: 'top rows by the join key past an offset',
      sql: 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.K LIMIT 17 OFFSET 40',
      column: 'K',
      elided: 'TopN',
    },
    {
      name: 'a limit wider than the result',
      sql: 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.K LIMIT 100000',
      column: 'K',
      elided: 'TopN',
    },
  ];

  for (const { name, sql, column, elided } of cases) {
    it(`agrees on ${name}`, async () => {
      const merged = await planAndRun(true, sql);
      const reference = await planAndRun(false, sql);

      expect(merged.operators).toContain('MergeJoin');
      expect(merged.operators).not.toContain(elided);
      expect(reference.operators).toContain('HashJoin');
      expect(reference.operators).toContain(elided);

      expect(orderKeyValues(merged.rows, column)).toEqual(orderKeyValues(reference.rows, column));
      expect(isNonDecreasing(orderKeyValues(merged.rows, column))).toBe(true);
    });
  }

  it('returns the same rows, not merely the same keys, when no limit truncates ties', async () => {
    const sql = 'SELECT l.K, l.V, r.W FROM L l JOIN R r ON l.K = r.K ORDER BY l.K';
    const merged = await planAndRun(true, sql);
    const reference = await planAndRun(false, sql);

    expect(asMultiset(merged.rows)).toEqual(asMultiset(reference.rows));
    expect(merged.rows).toHaveLength(reference.rows.length);
  });
});

describe('a merge join plan keeps the ordering it cannot supply on its own', () => {
  const kept = [
    {
      name: 'a descending order the join does not deliver',
      sql: 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.K DESC',
      operator: 'Sort',
    },
    {
      name: 'an order on a column the join does not key on',
      sql: 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.V',
      operator: 'Sort',
    },
    {
      name: 'an order needing more keys than the join delivers',
      sql: 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.K, l.V',
      operator: 'Sort',
    },
    {
      name: 'an outer join whose unmatched rows carry null keys',
      sql: 'SELECT l.K, l.V FROM L l LEFT JOIN R r ON l.K = r.K ORDER BY l.K',
      operator: 'Sort',
    },
    {
      name: 'a top-n on a column the join does not key on',
      sql: 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.V LIMIT 10',
      operator: 'TopN',
    },
  ];

  for (const { name, sql, operator } of kept) {
    it(`keeps the ${operator} for ${name}`, async () => {
      const merged = await planAndRun(true, sql);

      expect(merged.operators).toContain('MergeJoin');
      expect(merged.operators).toContain(operator);
    });
  }

  it('orders descending results correctly despite the merge join beneath', async () => {
    const sql = 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.K DESC';
    const merged = await planAndRun(true, sql);
    const descending = orderKeyValues(merged.rows, 'K');

    expect(descending.every((value, index) => index === 0 || descending[index - 1] >= value)).toBe(true);
  });
});

describe('the default cost model prefers a hash join over sorting both inputs', () => {
  it('leaves the merge join unchosen when neither input carries the join order', async () => {
    const sql = 'SELECT l.K, l.V FROM L l JOIN R r ON l.K = r.K ORDER BY l.K';
    const chosen = await planAndRun(false, sql);

    expect(chosen.operators).toContain('HashJoin');
    expect(chosen.operators).not.toContain('MergeJoin');
  });
});
