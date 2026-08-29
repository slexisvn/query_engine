import { describe, it, expect } from 'vitest';
import '../../../src/index.js';
import { createEngine, registerTable } from '../../../src/engine-entry.js';
import { flattenProfile } from '../../../src/execution/execution-profile.js';
import { DataType } from '../../../src/storage/data-type.js';

const EMP_SCHEMA = [
  { name: 'ID', dataType: DataType.INT32 },
  { name: 'DEPT', dataType: DataType.INT32 },
];

const DEPT_SCHEMA = [
  { name: 'DEPT', dataType: DataType.INT32 },
  { name: 'DNAME', dataType: DataType.VARCHAR },
];

async function engineWithoutUnnesting() {
  const engine = createEngine();
  registerTable(engine, 'EMP', [[1, 10], [2, 10], [3, 20], [4, null]], EMP_SCHEMA);
  registerTable(engine, 'DEPT', [[10, 'sales'], [20, 'eng'], [30, 'hr']], DEPT_SCHEMA);
  const withoutUnnesting = engine.createOptimizer.bind(engine);
  engine.createOptimizer = (statistics) => withoutUnnesting(statistics).removePass('SubqueryUnnesting');
  engine.optimizer = engine.createOptimizer(engine.precomputedStats);
  await engine.run('SELECT COUNT(*) AS C FROM EMP');
  return engine;
}

describe('buildDependentJoin', () => {
  it('refuses a correlated dependent join instead of evaluating it uncorrelated', async () => {
    const engine = await engineWithoutUnnesting();

    await expect(engine.run('SELECT ID FROM EMP E WHERE EXISTS (SELECT 1 FROM DEPT D WHERE D.DEPT = E.DEPT)'))
      .rejects.toThrow(/without being decorrelated/);

    engine.close();
  });

  it('names the subquery type it could not decorrelate', async () => {
    const engine = await engineWithoutUnnesting();

    await expect(engine.run('SELECT ID, (SELECT COUNT(*) FROM DEPT D WHERE D.DEPT = E.DEPT) AS C FROM EMP E'))
      .rejects.toThrow(/Correlated SCALAR subquery/);

    engine.close();
  });

  it('still evaluates an uncorrelated dependent join', async () => {
    const engine = await engineWithoutUnnesting();

    const result = await engine.run('SELECT ID FROM EMP WHERE EXISTS (SELECT 1 FROM DEPT WHERE DEPT.DEPT = 10)');

    expect(result.rows.map(row => row.ID).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    engine.close();
  });

  it('drops every row when an uncorrelated EXISTS subquery is empty', async () => {
    const engine = await engineWithoutUnnesting();

    const result = await engine.run('SELECT ID FROM EMP WHERE EXISTS (SELECT 1 FROM DEPT WHERE DEPT.DEPT = 99)');

    expect(result.rows).toEqual([]);

    engine.close();
  });
});

const ORDER_SCHEMA = [
  { name: 'ID', dataType: DataType.INT32 },
  { name: 'CUST', dataType: DataType.INT32 },
  { name: 'PRICE', dataType: DataType.INT32 },
];

const ORDERS = [[1, 10, 300], [2, 10, 100], [3, 20, 400], [4, 20, 500], [5, 30, 250]];
const PRICE_FLOOR = 200;
const HIGHER_PRICE_FLOOR = 400;

const keptIds = (priceFloor) => ORDERS.filter(([, , price]) => price > priceFloor).map(([id]) => id);

const joinedTwice = (priceFloor) => `WITH BIG AS (SELECT ID, CUST FROM ORDERS WHERE PRICE > ${priceFloor})
SELECT a.ID AS A_ID, b.ID AS B_ID
FROM BIG a JOIN BIG b ON a.CUST = b.CUST
WHERE a.ID < b.ID`;

const unionedTwice = (priceFloor) => `WITH BIG AS (SELECT ID FROM ORDERS WHERE PRICE > ${priceFloor})
SELECT ID FROM BIG UNION ALL SELECT ID FROM BIG`;

const SELF_JOINED_ROWS = [{ A_ID: 3, B_ID: 4 }];

function engineWithOrders() {
  const engine = createEngine();
  registerTable(engine, 'ORDERS', ORDERS, ORDER_SCHEMA);
  return engine;
}

function countCompilations(engine) {
  const executor = engine.executor;
  const compile = executor.buildLogicalPipeline.bind(executor);
  const counter = { calls: 0 };
  executor.buildLogicalPipeline = (node) => {
    counter.calls++;
    return compile(node);
  };
  return counter;
}

describe('buildCTEScan', () => {
  it('compiles a twice-referenced CTE once', async () => {
    const engine = engineWithOrders();
    const compilations = countCompilations(engine);

    const result = await engine.run(joinedTwice(PRICE_FLOOR));

    expect(compilations.calls).toBe(1);
    expect(result.rows).toEqual(SELF_JOINED_ROWS);

    engine.close();
  });

  it('leaves behind no pipeline that was built but never registered', async () => {
    const engine = engineWithOrders();

    const result = await engine.runProfiled(joinedTwice(PRICE_FLOOR));
    const invocations = flattenProfile(result.profile.roots).map(entry => entry.invocations);

    expect(result.profile.roots).toHaveLength(2);
    expect(invocations.filter(count => count !== 1)).toEqual([]);
    expect(result.rows).toEqual(SELF_JOINED_ROWS);

    engine.close();
  });

  it('registers the shared pipeline once even when both scans run as independent pipelines', async () => {
    const engine = engineWithOrders();
    const compilations = countCompilations(engine);

    const result = await engine.runProfiled(unionedTwice(PRICE_FLOOR));
    const [, cteRoot] = result.profile.roots;

    expect(compilations.calls).toBe(1);
    expect(result.profile.roots).toHaveLength(2);
    expect(cteRoot.profile.invocations).toBe(1);
    expect(result.rows.map(row => row.ID)).toEqual([...keptIds(PRICE_FLOOR), ...keptIds(PRICE_FLOOR)]);

    engine.close();
  });

  it('discards the compiled CTE between executions', async () => {
    const engine = engineWithOrders();

    const first = await engine.run(unionedTwice(PRICE_FLOOR));
    const second = await engine.run(unionedTwice(HIGHER_PRICE_FLOOR));

    expect(first.rows.map(row => row.ID)).toEqual([...keptIds(PRICE_FLOOR), ...keptIds(PRICE_FLOOR)]);
    expect(second.rows.map(row => row.ID)).toEqual([...keptIds(HIGHER_PRICE_FLOOR), ...keptIds(HIGHER_PRICE_FLOOR)]);

    engine.close();
  });
});
