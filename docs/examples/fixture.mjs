import { fileURLToPath } from 'node:url';
import { createEngine } from '../../dist/index.js';
import { CSVLoader } from '../../dist/cli/loaders/csv-loader.js';

export const runningQuery = `SELECT c.C_NAME, SUM(o.O_TOTALPRICE) AS TOTAL
FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE c.C_MKTSEGMENT = 'BUILDING'
GROUP BY c.C_NAME
ORDER BY TOTAL DESC
LIMIT 10`;

export const expectedRows = [
  { C_NAME: 'Alice', TOTAL: 350 },
  { C_NAME: 'Carol', TOTAL: 300 },
];

// Use the same CSVs as the REPL so the two entry points share data and types.
export async function createBookEngine() {
  const engine = createEngine();
  try {
    const loader = new CSVLoader();
    for (const name of ['customer.csv', 'orders.csv']) {
      await loader.load(engine, fileURLToPath(new URL(name, import.meta.url)));
    }
    return engine;
  } catch (error) {
    await engine.close();
    throw error;
  }
}
