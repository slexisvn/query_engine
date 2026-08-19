import { describe, it, expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { PhysicalNodeType } from '../../src/execution/physical-plan.js';

const LEFT_ROWS = [
  { K: 1, LV: 'l1' },
  { K: 2, LV: 'l2' },
  { K: 2, LV: 'l2b' },
  { K: null, LV: 'lnull' },
];

const RIGHT_ROWS = [
  { K: 2, RV: 'r2' },
  { K: 3, RV: 'r3' },
  { K: null, RV: 'rnull' },
];

const OPERATORS = [
  PhysicalNodeType.HASH_JOIN,
  PhysicalNodeType.MERGE_JOIN,
  PhysicalNodeType.NESTED_LOOP_JOIN,
];

function forceJoinOperator(engine, type) {
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

function sorted(rows) {
  return rows.map(row => JSON.stringify(row)).sort();
}

async function runOn(operator, sql, left = LEFT_ROWS, right = RIGHT_ROWS) {
  const engine = createEngine();
  registerTable(engine, 'L', left);
  registerTable(engine, 'R', right);
  await engine.run('SELECT COUNT(*) AS C FROM L');
  await engine.run('SELECT COUNT(*) AS C FROM R');
  const forced = forceJoinOperator(engine, operator);

  const result = await engine.run(sql);
  engine.close();

  expect(forced.count).toBeGreaterThan(0);
  return sorted(result.rows);
}

describe('outer join semantics', () => {
  for (const operator of OPERATORS) {
    describe(operator, () => {
      it('LEFT JOIN keeps every left row exactly once per match', async () => {
        const rows = await runOn(operator, 'SELECT L.LV AS LV, R.RV AS RV FROM L LEFT JOIN R ON L.K = R.K');

        expect(rows).toEqual(sorted([
          { LV: 'l1', RV: null },
          { LV: 'l2', RV: 'r2' },
          { LV: 'l2b', RV: 'r2' },
          { LV: 'lnull', RV: null },
        ]));
      });

      it('RIGHT JOIN keeps every right row, including the one no left row matches', async () => {
        const rows = await runOn(operator, 'SELECT L.LV AS LV, R.RV AS RV FROM L RIGHT JOIN R ON L.K = R.K');

        expect(rows).toEqual(sorted([
          { LV: 'l2', RV: 'r2' },
          { LV: 'l2b', RV: 'r2' },
          { LV: null, RV: 'r3' },
          { LV: null, RV: 'rnull' },
        ]));
      });

      it('FULL OUTER JOIN keeps unmatched rows from both sides', async () => {
        const rows = await runOn(operator, 'SELECT L.LV AS LV, R.RV AS RV FROM L FULL OUTER JOIN R ON L.K = R.K');

        expect(rows).toEqual(sorted([
          { LV: 'l1', RV: null },
          { LV: 'l2', RV: 'r2' },
          { LV: 'l2b', RV: 'r2' },
          { LV: 'lnull', RV: null },
          { LV: null, RV: 'r3' },
          { LV: null, RV: 'rnull' },
        ]));
      });

      it('RIGHT JOIN on a left side that matches nothing keeps the whole right side', async () => {
        const rows = await runOn(
          operator,
          'SELECT L.LV AS LV, R.RV AS RV FROM L RIGHT JOIN R ON L.K = R.K',
          [{ K: 9, LV: 'x' }],
        );

        expect(rows).toEqual(sorted([
          { LV: null, RV: 'r2' },
          { LV: null, RV: 'r3' },
          { LV: null, RV: 'rnull' },
        ]));
      });

      it('INNER JOIN never matches NULL keys', async () => {
        const rows = await runOn(operator, 'SELECT L.LV AS LV, R.RV AS RV FROM L JOIN R ON L.K = R.K');

        expect(rows).toEqual(sorted([
          { LV: 'l2', RV: 'r2' },
          { LV: 'l2b', RV: 'r2' },
        ]));
      });
    });
  }
});
