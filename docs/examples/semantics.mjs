import assert from 'node:assert/strict';
import { registerTable, DataType } from '../../dist/index.js';
import { createBookEngine } from './fixture.mjs';

const engine = await createBookEngine();
try {
  const rows = async sql => (await engine.run(sql)).rows;
  assert.throws(() => engine.bind(engine.parseSQL("SELECT C_NAME AS NM FROM CUSTOMER WHERE NM = 'Alice'")), /Unknown column: NM/);
  assert.deepEqual(await rows('SELECT C_NAME AS NM FROM CUSTOMER ORDER BY NM'),
    [{ NM: 'Alice' }, { NM: 'Bob' }, { NM: 'Carol' }]);

  const where = await rows(`SELECT c.C_NAME AS N, o.O_TOTALPRICE AS P
    FROM CUSTOMER c LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
    WHERE o.O_TOTALPRICE > 500 ORDER BY c.C_NAME`);
  const on = await rows(`SELECT c.C_NAME AS N, o.O_TOTALPRICE AS P
    FROM CUSTOMER c LEFT JOIN ORDERS o
      ON c.C_CUSTKEY = o.O_CUSTKEY AND o.O_TOTALPRICE > 500
    ORDER BY c.C_NAME`);
  assert.deepEqual(where, [{ N: 'Bob', P: 900 }]);
  assert.deepEqual(on, [{ N: 'Alice', P: null }, { N: 'Bob', P: 900 }, { N: 'Carol', P: null }]);
  assert.deepEqual(await rows('SELECT COUNT(*) AS N FROM CUSTOMER WHERE 1 = 0'), [{ N: 0 }]);
  assert.deepEqual(await rows('SELECT C_NAME, COUNT(*) AS N FROM CUSTOMER WHERE 1 = 0 GROUP BY C_NAME'), []);
  assert.deepEqual(await rows('SELECT SUM(O_TOTALPRICE) AS S FROM ORDERS WHERE 1 = 0'), [{ S: null }]);

  registerTable(engine, 'NULL_KEYS', [{ K: 1 }, { K: null }], [{ name: 'K', dataType: DataType.INT32 }]);
  assert.deepEqual(await rows('SELECT C_NAME FROM CUSTOMER WHERE C_CUSTKEY NOT IN (SELECT K FROM NULL_KEYS)'), []);
  assert.deepEqual(await rows(`SELECT C_NAME FROM CUSTOMER c
    WHERE NOT EXISTS (SELECT 1 FROM NULL_KEYS n WHERE n.K = c.C_CUSTKEY) ORDER BY C_NAME`),
    [{ C_NAME: 'Bob' }, { C_NAME: 'Carol' }]);

  console.log('Alias lookup, outer-join placement, empty aggregation, and nullable subquery checks passed.');
  console.log('WHERE result:', where);
  console.log('ON result:', on);
} finally {
  await engine.close();
}
