import assert from 'node:assert/strict';
import { createBookEngine, expectedRows, runningQuery } from './fixture.mjs';

const engine = await createBookEngine();
try {
  const result = await engine.run(runningQuery);
  assert.deepEqual(result.rows, expectedRows);
  console.table(result.rows);
} finally {
  await engine.close();
}
