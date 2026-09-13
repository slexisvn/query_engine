import assert from 'node:assert/strict';
import { createEngine, registerTable, DataType } from '../../dist/index.js';

const engine = createEngine();
try {
  registerTable(engine, 'FRAME_SAMPLE', [10, 10, 14, 20].map((K, i) => ({ ID: i + 1, K })), [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'K', dataType: DataType.INT32 },
  ]);
  const result = await engine.run(`SELECT ID, K,
    SUM(K) OVER (ORDER BY K, ID ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS R,
    SUM(K) OVER (ORDER BY K GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) AS G,
    SUM(K) OVER (ORDER BY K RANGE BETWEEN 3 PRECEDING AND CURRENT ROW) AS V
    FROM FRAME_SAMPLE ORDER BY ID`);
  assert.deepEqual(result.rows, [
    { ID: 1, K: 10, R: 10, G: 20, V: 20 },
    { ID: 2, K: 10, R: 20, G: 20, V: 20 },
    { ID: 3, K: 14, R: 24, G: 34, V: 14 },
    { ID: 4, K: 20, R: 34, G: 34, V: 20 },
  ]);
  console.table(result.rows);
} finally {
  await engine.close();
}
