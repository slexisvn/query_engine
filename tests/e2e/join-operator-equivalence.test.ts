import { describe, it, expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { PhysicalPlanner } from '../../src/execution/physical-planner.js';
import { PhysicalNodeType } from '../../src/execution/physical-plan.js';
import { deterministicRandom } from '../../src/catalog/reservoir-sample.js';

function forceJoinOperator(engine, type) {
  const planner = engine.executor.physicalPlanner;
  const original = planner.joinCandidates.bind(planner);
  const forced = { count: 0 };
  planner.joinCandidates = (node, children) => {
    const candidates = original(node, children);
    const wanted = candidates.filter(candidate => candidate.type === type);
    if (wanted.length === 0) throw new Error(`${type} is not a candidate for this join`);
    forced.count++;
    return [wanted[0]];
  };
  return forced;
}

function buildRows(count, keySpread, seed) {
  const random = deterministicRandom(seed);
  return Array.from({ length: count }, (_, i) => {
    const draw = random();
    return {
      K: draw < 0.1 ? null : Math.floor(draw * keySpread),
      V: i,
    };
  });
}

function normalize(rows, columns) {
  return rows
    .map(row => columns.map(name => (row[name] === undefined ? null : row[name])).join(''))
    .sort();
}

async function runWith(operatorType, sql, left, right) {
  const engine = createEngine();
  registerTable(engine, 'L', left);
  registerTable(engine, 'R', right);
  await engine.run('SELECT COUNT(*) AS C FROM L');
  await engine.run('SELECT COUNT(*) AS C FROM R');
  const forced = forceJoinOperator(engine, operatorType);

  const result = await engine.run(sql);
  const rows = normalize(result.rows, result.columns);
  engine.close();
  return { rows, forcedJoins: forced.count };
}

describe('hash join and merge join agree', () => {
  const shapes = [
    { name: 'INNER', sql: 'SELECT L.K AS LK, L.V AS LV, R.V AS RV FROM L JOIN R ON L.K = R.K' },
    { name: 'LEFT', sql: 'SELECT L.K AS LK, L.V AS LV, R.V AS RV FROM L LEFT JOIN R ON L.K = R.K' },
    { name: 'RIGHT', sql: 'SELECT L.V AS LV, R.K AS RK, R.V AS RV FROM L RIGHT JOIN R ON L.K = R.K' },
    { name: 'residual predicate', sql: 'SELECT L.V AS LV, R.V AS RV FROM L JOIN R ON L.K = R.K AND L.V > R.V' },
    { name: 'IN subquery', sql: 'SELECT L.V AS LV FROM L WHERE L.K IN (SELECT R.K FROM R)' },
    { name: 'NOT IN subquery', sql: 'SELECT L.V AS LV FROM L WHERE L.K NOT IN (SELECT R.K FROM R)' },
    { name: 'EXISTS subquery', sql: 'SELECT L.V AS LV FROM L WHERE EXISTS (SELECT 1 FROM R WHERE R.K = L.K)' },
  ];

  const datasets = [
    { name: 'many duplicate keys', left: buildRows(120, 5, 1), right: buildRows(90, 5, 2) },
    { name: 'mostly distinct keys', left: buildRows(120, 200, 3), right: buildRows(90, 200, 4) },
    { name: 'disjoint key ranges', left: buildRows(60, 10, 5), right: buildRows(60, 10, 6).map(r => ({ ...r, K: r.K === null ? null : r.K + 100 })) },
    { name: 'empty probe side', left: buildRows(40, 8, 7), right: [] },
  ];

  for (const shape of shapes) {
    for (const dataset of datasets) {
      it(`${shape.name} over ${dataset.name}`, async () => {
        const right = dataset.right.length > 0 ? dataset.right : [{ K: null, V: null }];
        const viaHash = await runWith(PhysicalNodeType.HASH_JOIN, shape.sql, dataset.left, right);
        const viaMerge = await runWith(PhysicalNodeType.MERGE_JOIN, shape.sql, dataset.left, right);

        expect(viaMerge.forcedJoins).toBeGreaterThan(0);
        expect(viaHash.forcedJoins).toBe(viaMerge.forcedJoins);
        expect(viaMerge.rows).toEqual(viaHash.rows);
      });
    }
  }

  it('actually exercises both operators rather than silently planning the same one', async () => {
    const left = buildRows(40, 6, 11);
    const right = buildRows(40, 6, 12);

    const engine = createEngine();
    registerTable(engine, 'L', left);
    registerTable(engine, 'R', right);
    await engine.run('SELECT COUNT(*) AS C FROM L');

    const compiled = await engine.compile('SELECT L.V AS LV, R.V AS RV FROM L JOIN R ON L.K = R.K');
    const planner = new PhysicalPlanner();
    const candidates = planner.joinCandidates(
      findJoin(compiled.plan),
      findJoin(compiled.plan).children.map(child => planner.planNode(child)),
    );

    const types = candidates.map(candidate => candidate.type);
    expect(types).toContain(PhysicalNodeType.HASH_JOIN);
    expect(types).toContain(PhysicalNodeType.MERGE_JOIN);
    engine.close();
  });
});

function findJoin(node) {
  if (node.type === 'Join') return node;
  for (const child of node.children || []) {
    const found = findJoin(child);
    if (found) return found;
  }
  return null;
}
