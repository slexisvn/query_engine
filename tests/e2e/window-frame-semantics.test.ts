import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';

const ROWS = [
  { A: 1, B: 10 },
  { A: 2, B: 20 },
  { A: 2, B: 25 },
  { A: 4, B: 40 },
  { A: 7, B: 70 },
];

let engine;

beforeAll(async () => {
  engine = createEngine();
  registerTable(engine, 'W', ROWS);
  await engine.run('SELECT COUNT(*) AS C FROM W');
});

afterAll(() => {
  engine.close();
});

async function values(sql) {
  const result = await engine.run(sql);
  return result.rows.map(row => row.S);
}

describe('RANGE frames with value offsets', () => {
  it('sums a trailing value window', async () => {
    expect(await values(
      'SELECT SUM(B) OVER (ORDER BY A RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS S FROM W ORDER BY A',
    )).toEqual([10, 55, 55, 40, 70]);
  });

  it('sums a centred value window', async () => {
    expect(await values(
      'SELECT SUM(B) OVER (ORDER BY A RANGE BETWEEN 2 PRECEDING AND 2 FOLLOWING) AS S FROM W ORDER BY A',
    )).toEqual([55, 95, 95, 85, 70]);
  });

  it('follows the ordering direction for DESC', async () => {
    expect(await values(
      'SELECT SUM(B) OVER (ORDER BY A DESC RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS S FROM W ORDER BY A DESC',
    )).toEqual([70, 40, 45, 45, 55]);
  });

  it('yields an empty frame when the window covers no values', async () => {
    expect(await values(
      'SELECT SUM(B) OVER (ORDER BY A RANGE BETWEEN 100 FOLLOWING AND 200 FOLLOWING) AS S FROM W ORDER BY A',
    )).toEqual([null, null, null, null, null]);
  });

  it('rejects a value offset without ORDER BY', async () => {
    await expect(engine.run(
      'SELECT SUM(B) OVER (RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS S FROM W',
    )).rejects.toThrow(/require an ORDER BY clause/);
  });

  it('rejects a value offset over two ordering columns', async () => {
    await expect(engine.run(
      'SELECT SUM(B) OVER (ORDER BY A, B RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) AS S FROM W',
    )).rejects.toThrow(/exactly one ORDER BY column/);
  });
});

describe('GROUPS frames', () => {
  it('counts whole peer groups backwards', async () => {
    expect(await values(
      'SELECT SUM(B) OVER (ORDER BY A GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS S FROM W ORDER BY A',
    )).toEqual([10, 55, 55, 85, 110]);
  });

  it('counts whole peer groups forwards', async () => {
    const result = await engine.run(
      'SELECT COUNT(*) OVER (ORDER BY A GROUPS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS S FROM W ORDER BY A',
    );
    expect(result.rows.map(row => row.S)).toEqual([3, 3, 3, 2, 1]);
  });

  it('yields an empty frame past the last group', async () => {
    expect(await values(
      'SELECT SUM(B) OVER (ORDER BY A GROUPS BETWEEN 9 FOLLOWING AND 10 FOLLOWING) AS S FROM W ORDER BY A',
    )).toEqual([null, null, null, null, null]);
  });

  it('rejects GROUPS without ORDER BY', async () => {
    await expect(engine.run(
      'SELECT SUM(B) OVER (GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS S FROM W',
    )).rejects.toThrow(/GROUPS window frames require an ORDER BY clause/);
  });
});

describe('frame bound validation', () => {
  it('rejects UNBOUNDED FOLLOWING as a start bound', async () => {
    await expect(engine.run(
      'SELECT SUM(B) OVER (ORDER BY A ROWS BETWEEN UNBOUNDED FOLLOWING AND CURRENT ROW) AS S FROM W',
    )).rejects.toThrow(/start bound cannot be UNBOUNDED FOLLOWING/);
  });

  it('rejects UNBOUNDED PRECEDING as an end bound', async () => {
    await expect(engine.run(
      'SELECT SUM(B) OVER (ORDER BY A ROWS BETWEEN CURRENT ROW AND UNBOUNDED PRECEDING) AS S FROM W',
    )).rejects.toThrow(/end bound cannot be UNBOUNDED PRECEDING/);
  });
});
