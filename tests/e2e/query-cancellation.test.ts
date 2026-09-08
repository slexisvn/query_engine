import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { QueryCancelledError } from '../../src/execution/pipeline.js';
import { DataType } from '../../src/storage/data-type.js';

const ROW_COUNT = 400000;
const GROUP_COUNT = 500;

const SCHEMA = [
  { name: 'ID', dataType: DataType.INT32 },
  { name: 'V', dataType: DataType.INT32 },
];

const ROWS = Array.from({ length: ROW_COUNT }, (_, i) => [i, i % GROUP_COUNT]);

const LONG = `SELECT V, COUNT(*) AS N, SUM(ID) AS S FROM T GROUP BY V`;

let engine;

beforeEach(() => {
  engine = createEngine();
  registerTable(engine, 'T', ROWS, SCHEMA);
});

afterEach(() => engine.close());

function abortAfter(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return controller.signal;
}

async function timeOf(body) {
  const started = Date.now();
  const outcome = await body().then(() => 'fulfilled', (err) => err);
  return { ms: Date.now() - started, outcome };
}

describe('query cancellation', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(engine.run(LONG, [], { signal: controller.signal })).rejects.toBeInstanceOf(QueryCancelledError);
  });

  it('stops a running query well before it would have finished', async () => {
    const uninterrupted = await timeOf(() => engine.run(LONG));
    expect(uninterrupted.outcome).toBe('fulfilled');

    const cancelled = await timeOf(() => engine.run(LONG, [], { signal: abortAfter(Math.round(uninterrupted.ms / 10)) }));

    expect(cancelled.outcome).toBeInstanceOf(QueryCancelledError);
    expect(cancelled.ms).toBeLessThan(uninterrupted.ms);
  });

  it('leaves the engine usable afterwards', async () => {
    await expect(engine.run(LONG, [], { signal: abortAfter(1) })).rejects.toBeInstanceOf(QueryCancelledError);

    const after = await engine.run('SELECT COUNT(*) AS N FROM T');

    expect(after.rows).toEqual([{ N: ROW_COUNT }]);
  });

  it('cancels only the query that was given the signal', async () => {
    const expected = (await engine.run(LONG)).rows;

    const [victim, bystander] = await Promise.allSettled([
      engine.run(LONG, [], { signal: abortAfter(1) }),
      engine.run(LONG),
    ]);

    expect(victim.status).toBe('rejected');
    expect(victim.reason).toBeInstanceOf(QueryCancelledError);
    expect(bystander.status).toBe('fulfilled');
    expect(bystander.value.rows).toEqual(expected);
  });

  it('runs untouched when no signal is given', async () => {
    const controller = new AbortController();
    const withSignal = await engine.run(LONG, [], { signal: controller.signal });
    const without = await engine.run(LONG);

    expect(withSignal.rows).toEqual(without.rows);
  });

  it('still lets LIMIT stop its own input without cancelling the query', async () => {
    const limited = await engine.run('SELECT ID FROM T LIMIT 5', [], { signal: new AbortController().signal });

    expect(limited.rows).toHaveLength(5);
  });
});
