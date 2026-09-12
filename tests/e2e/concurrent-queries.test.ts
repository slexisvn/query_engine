import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { DataType } from '../../src/storage/data-type.js';

const ROW_COUNT = 4000;
const GROUP_COUNT = 10;
const ROUNDS = 12;

const SCHEMA = [
  { name: 'ID', dataType: DataType.INT32 },
  { name: 'V', dataType: DataType.INT32 },
];

const ROWS = Array.from({ length: ROW_COUNT }, (_, i) => [i, i % GROUP_COUNT]);

const sameNameCte = (value) =>
  `WITH C AS (SELECT ID, V FROM T WHERE V = ${value}) SELECT COUNT(*) AS N, SUM(V) AS S FROM C`;

const uniqueNameCte = (name, value) =>
  `WITH ${name} AS (SELECT ID, V FROM T WHERE V = ${value}) SELECT COUNT(*) AS N, SUM(V) AS S FROM ${name}`;

const plain = (value) => `SELECT COUNT(*) AS N, SUM(V) AS S FROM T WHERE V = ${value}`;

let engine;

beforeEach(() => {
  engine = createEngine();
  registerTable(engine, 'T', ROWS, SCHEMA);
});

afterEach(() => engine.close());

async function alone(sqls) {
  const answers = [];
  for (const sql of sqls) answers.push(await engine.run(sql));
  return answers;
}

async function together(sqls) {
  return Promise.all(sqls.map(sql => engine.run(sql)));
}

async function expectSameAnswersConcurrently(sqls) {
  const expected = (await alone(sqls)).map(result => result.rows);

  for (let round = 0; round < ROUNDS; round++) {
    const got = (await together(sqls)).map(result => result.rows);
    expect(got).toEqual(expected);
  }
}

describe('concurrent queries on one engine', () => {
  it('keeps CTEs of the same name apart', async () => {
    await expectSameAnswersConcurrently([sameNameCte(1), sameNameCte(7)]);
  });

  it('keeps CTEs of the same name apart across more queries than it has cores', async () => {
    await expectSameAnswersConcurrently([
      sameNameCte(1), sameNameCte(3), sameNameCte(7), sameNameCte(1), sameNameCte(9),
    ]);
  });

  it('does not let one query discard another query\'s materialized CTE', async () => {
    await expectSameAnswersConcurrently([uniqueNameCte('ALPHA', 1), uniqueNameCte('BETA', 7), plain(4)]);
  });

  it('keeps a failing query from disturbing the ones beside it', async () => {
    const expected = (await alone([sameNameCte(1), plain(4)])).map(result => result.rows);

    for (let round = 0; round < ROUNDS; round++) {
      const settled = await Promise.allSettled([
        engine.run(sameNameCte(1)),
        engine.run('SELECT COUNT(*) FROM MISSING_TABLE'),
        engine.run(plain(4)),
      ]);

      expect(settled.map(entry => entry.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      expect([settled[0].value.rows, settled[2].value.rows]).toEqual(expected);
    }
  });

  it('gives each concurrent self-join the answer it gets alone', async () => {
    const selfJoin = (floor) =>
      `SELECT COUNT(*) AS N, SUM(a.V) AS S FROM T a JOIN T b ON a.V = b.V WHERE a.ID < ${floor}`;

    await expectSameAnswersConcurrently([selfJoin(200), selfJoin(500), selfJoin(200)]);
  });
});
