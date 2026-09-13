import assert from 'node:assert/strict';
import { col, sum } from '../../dist/index.js';
import { createBookEngine, expectedRows } from './fixture.mjs';

const engine = await createBookEngine();
try {
  const customers = engine.table('CUSTOMER')
    .filter(col('C_MKTSEGMENT').eq('BUILDING'))
    .select(col('C_CUSTKEY').alias('customer_key'), 'C_NAME');
  const orders = engine.table('ORDERS')
    .select(col('O_CUSTKEY').alias('customer_key'), 'O_TOTALPRICE');
  const query = customers.join(orders, 'customer_key')
    .groupBy('C_NAME')
    .agg(sum('O_TOTALPRICE').alias('TOTAL'))
    .orderBy(col('TOTAL').desc())
    .limit(10);
  console.log(query.explain());
  const rows = await query.collect();
  assert.deepEqual(rows, expectedRows);
  console.table(rows);
} finally {
  await engine.close();
}
