import { expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { PhysicalNodeType } from '../../src/execution/physical-plan.js';
import { DataType } from '../../src/storage/data-type.js';

export const JOIN_OPERATORS = [
  PhysicalNodeType.HASH_JOIN,
  PhysicalNodeType.MERGE_JOIN,
  PhysicalNodeType.NESTED_LOOP_JOIN,
];

export const NON_EQUI_JOIN_OPERATORS = [
  PhysicalNodeType.HASH_JOIN,
  PhysicalNodeType.NESTED_LOOP_JOIN,
];

export const EMP_ROWS = [
  { ID: 1, NAME: 'alice', DEPT: 10, SAL: 100, MGR: null },
  { ID: 2, NAME: 'bob', DEPT: 10, SAL: 200, MGR: 1 },
  { ID: 3, NAME: 'carol', DEPT: 20, SAL: 300, MGR: 1 },
  { ID: 4, NAME: 'dave', DEPT: 20, SAL: null, MGR: 2 },
  { ID: 5, NAME: 'eve', DEPT: null, SAL: 500, MGR: 2 },
];

export const DEPT_ROWS = [
  { DEPT: 10, DNAME: 'sales' },
  { DEPT: 20, DNAME: 'eng' },
  { DEPT: 30, DNAME: 'hr' },
];

export const T_ROWS = [
  { K: 'a', V: 1 },
  { K: 'a', V: 2 },
  { K: 'b', V: 3 },
  { K: 'b', V: 3 },
  { K: 'c', V: null },
  { K: null, V: 5 },
];

export async function makeEngine() {
  const engine = createEngine();
  registerTable(engine, 'EMP', EMP_ROWS);
  registerTable(engine, 'DEPT', DEPT_ROWS);
  registerTable(engine, 'T', T_ROWS);
  registerTable(engine, 'E0', [{ Z: 1 }]);
  registerTable(engine, 'DT', [{ D: 18262 }, { D: 18292 }], [{ name: 'D', dataType: DataType.DATE }]);
  for (const table of ['EMP', 'DEPT', 'T', 'E0', 'DT']) {
    await engine.run(`SELECT COUNT(*) AS C FROM ${table}`);
  }
  return engine;
}

export function forceJoinOperator(engine, type) {
  const planner = engine.executor.physicalPlanner;
  const original = planner.joinCandidates.bind(planner);
  const forced = { count: 0 };
  planner.joinCandidates = (node, children) => {
    const wanted = original(node, children).filter(candidate => candidate.type === type);
    if (wanted.length === 0) throw new Error(`${type} is not a candidate for this join`);
    forced.count++;
    return [wanted[0]];
  };
  return forced;
}

export async function runQuery(sql) {
  const engine = await makeEngine();
  const result = await engine.run(sql);
  engine.close();
  return result.rows;
}

export async function runQueryOn(operator, sql) {
  const engine = await makeEngine();
  const forced = forceJoinOperator(engine, operator);
  const result = await engine.run(sql);
  engine.close();
  expect(forced.count).toBeGreaterThan(0);
  return result.rows;
}

export async function runQueryColumnTypes(sql) {
  const engine = await makeEngine();
  const result = await engine.stream(sql);
  const types = [];
  for await (const chunk of result.chunks()) {
    if (types.length === 0) types.push(...chunk.columns.map(column => column.dataType));
  }
  engine.close();
  return types;
}

export function sortedRows(rows) {
  return rows.map(row => JSON.stringify(row)).sort();
}
