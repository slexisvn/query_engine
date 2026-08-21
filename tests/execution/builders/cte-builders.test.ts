import { describe, it, expect } from 'vitest';
import '../../../src/index.js';
import { createEngine, registerTable } from '../../../src/engine-entry.js';
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
