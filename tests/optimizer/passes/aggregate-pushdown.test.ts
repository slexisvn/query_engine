import { describe, it, expect } from 'vitest';
import { parse } from '../../../src/parser/parser.js';
import { Binder } from '../../../src/binder/binder.js';
import { createLogicalPlan } from '../../../src/planner/logical-planner.js';
import { Catalog } from '../../../src/catalog/catalog.js';
import { defaultFunctionRegistry } from '../../../src/catalog/function-registry.js';
import { AggregatePushdown } from '../../../src/optimizer/passes/aggregate-pushdown.js';
import { ColumnStatistics, TableStatistics } from '../../../src/catalog/statistics.js';
import { PlanNodeType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { exprKey } from '../../../src/binder/expr-key.js';
import { PhysicalPlanner } from '../../../src/execution/physical-planner.js';
import { totalPhysicalCost } from '../../../src/execution/physical-plan.js';

const FACT_ROWS = 6000000;
const DIM_ROWS = 1500000;
const SMALL_DIM_ROWS = 25;

function createCatalog() {
  const catalog = new Catalog();
  catalog.registerTable('FACT', [
    { name: 'ORDER_ID', dataType: 'INT32' },
    { name: 'DIM_ID', dataType: 'INT32' },
    { name: 'SHIPMODE', dataType: 'VARCHAR' },
    { name: 'QTY', dataType: 'FLOAT64' },
    { name: 'PRICE', dataType: 'FLOAT64' },
  ]);
  catalog.registerTable('DIM', [
    { name: 'ORDER_ID', dataType: 'INT32' },
    { name: 'STATUS', dataType: 'VARCHAR' },
  ], { primaryKey: ['ORDER_ID'] });
  catalog.registerTable('SMALLDIM', [
    { name: 'DIM_ID', dataType: 'INT32' },
    { name: 'DIM_NAME', dataType: 'VARCHAR' },
  ], { primaryKey: ['DIM_ID'] });
  return catalog;
}

function col(ndv) {
  return new ColumnStatistics({ ndv, min: 0, max: ndv });
}

function table(rowCount, columns) {
  const map = new Map();
  for (const [name, stats] of Object.entries(columns)) map.set(name.toUpperCase(), stats);
  return new TableStatistics(rowCount, map);
}

function statistics() {
  return new Map([
    ['FACT', table(FACT_ROWS, {
      ORDER_ID: col(DIM_ROWS), DIM_ID: col(SMALL_DIM_ROWS), SHIPMODE: col(7),
      QTY: col(50), PRICE: col(100000),
    })],
    ['DIM', table(DIM_ROWS, { ORDER_ID: col(DIM_ROWS), STATUS: col(3) })],
    ['SMALLDIM', table(SMALL_DIM_ROWS, { DIM_ID: col(SMALL_DIM_ROWS), DIM_NAME: col(SMALL_DIM_ROWS) })],
  ]);
}

function logicalPlan(sql) {
  const catalog = createCatalog();
  return createLogicalPlan(new Binder(catalog, defaultFunctionRegistry).bind(parse(sql)));
}

function pushdown(sql, stats = statistics()) {
  return new AggregatePushdown(stats).apply(logicalPlan(sql));
}

function physicalCost(plan, stats) {
  return totalPhysicalCost(new PhysicalPlanner(stats).plan(plan));
}

function findNode(plan, type) {
  const stack = [plan];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === type) return node;
    for (const child of node.children || []) stack.push(child);
  }
  return null;
}

function fired(plan) {
  return findNode(plan, PlanNodeType.PARTIAL_AGGREGATE) !== null;
}

function finalAggregate(plan) {
  return findNode(plan, PlanNodeType.FINAL_AGGREGATE);
}

function columnKeys(exprs) {
  return exprs.map(expr => `${expr.tableAlias}.${expr.columnName}`.toUpperCase());
}

const PUSHABLE = `
  SELECT f.ORDER_ID AS K, SUM(f.QTY) AS TOTAL
  FROM FACT f JOIN DIM d ON d.ORDER_ID = f.ORDER_ID
  GROUP BY f.ORDER_ID`;

describe('AggregatePushdown fires on a plan the binder actually produces', () => {
  it('splits the aggregate into a partial below the join and a final above', () => {
    const final = finalAggregate(pushdown(PUSHABLE));

    expect(final).not.toBeNull();
    const join = final.children[0];
    expect(join.type).toBe(PlanNodeType.JOIN);
    expect(join.children.some(child => child.type === PlanNodeType.PARTIAL_AGGREGATE)).toBe(true);
  });

  it('reads the function name off the binder field, not a fabricated one', () => {
    const partial = findNode(pushdown(PUSHABLE), PlanNodeType.PARTIAL_AGGREGATE);

    expect(partial.aggregates[0].kind).toBe(BoundExprKind.AGGREGATE);
    expect(partial.aggregates[0].name).toBe('SUM');
    expect(partial.aggregates[0].func).toBe('SUM');
  });

  it('converts COUNT to a partial COUNT and a final SUM', () => {
    const plan = pushdown(`
      SELECT f.ORDER_ID AS K, COUNT(f.QTY) AS N
      FROM FACT f JOIN DIM d ON d.ORDER_ID = f.ORDER_ID
      GROUP BY f.ORDER_ID`);

    expect(findNode(plan, PlanNodeType.PARTIAL_AGGREGATE).aggregates[0].func).toBe('COUNT');
    expect(finalAggregate(plan).aggregates[0].func).toBe('SUM');
  });

  it('leaves the final aggregate resolvable under its original identity', () => {
    const final = finalAggregate(pushdown(PUSHABLE));
    const bound = new Binder(createCatalog(), defaultFunctionRegistry).bind(parse(PUSHABLE));
    const untouched = findNode(createLogicalPlan(bound), PlanNodeType.AGGREGATE).aggregates[0];

    expect(exprKey(final.aggregates[0])).toBe(exprKey(untouched));
    expect(final.aggregates[0].args).toEqual(untouched.args);
  });
});

describe('AggregatePushdown keeps the join key in the partial grouping', () => {
  it('adds the join key when the group-by does not already contain it', () => {
    const plan = pushdown(`
      SELECT f.SHIPMODE AS M, SUM(f.QTY) AS TOTAL
      FROM FACT f JOIN SMALLDIM s ON s.DIM_ID = f.DIM_ID
      GROUP BY f.SHIPMODE`, new Map([
      ['FACT', table(FACT_ROWS, { DIM_ID: col(2), SHIPMODE: col(7), QTY: col(50) })],
      ['SMALLDIM', table(SMALL_DIM_ROWS, { DIM_ID: col(2), DIM_NAME: col(2) })],
    ]));

    const partial = findNode(plan, PlanNodeType.PARTIAL_AGGREGATE);
    expect(partial).not.toBeNull();
    expect(columnKeys(partial.groupBy)).toEqual(['F.SHIPMODE', 'F.DIM_ID']);
    expect(columnKeys(finalAggregate(plan).groupBy)).toEqual(['F.SHIPMODE']);
  });

  it('leaves the grouping alone when it already covers the join key', () => {
    const partial = findNode(pushdown(PUSHABLE), PlanNodeType.PARTIAL_AGGREGATE);
    expect(columnKeys(partial.groupBy)).toEqual(['F.ORDER_ID']);
  });
});

describe('AggregatePushdown declines when the rewrite would not pay', () => {
  it('declines when the join filters the side it would aggregate', () => {
    const plan = pushdown(`
      SELECT f.ORDER_ID AS K, SUM(f.QTY) AS TOTAL
      FROM FACT f JOIN SMALLDIM s ON s.DIM_ID = f.DIM_ID
      GROUP BY f.ORDER_ID`);

    expect(fired(plan)).toBe(false);
  });

  it('keeps the rewrite only when the physical cost actually drops', () => {
    const stats = statistics();
    const rewritten = pushdown(PUSHABLE, stats);

    expect(fired(rewritten)).toBe(true);
    expect(physicalCost(rewritten, stats)).toBeLessThan(physicalCost(logicalPlan(PUSHABLE), stats));
  });

  it('leaves the plan untouched when the rewrite would cost more', () => {
    const filtering = `
      SELECT f.ORDER_ID AS K, SUM(f.QTY) AS TOTAL
      FROM FACT f JOIN SMALLDIM s ON s.DIM_ID = f.DIM_ID
      GROUP BY f.ORDER_ID`;
    const stats = statistics();

    expect(fired(pushdown(filtering, stats))).toBe(false);
    expect(physicalCost(pushdown(filtering, stats), stats))
      .toBe(physicalCost(logicalPlan(filtering), stats));
  });

  it('declines when the input is too small to be worth a second aggregate', () => {
    const small = new Map([
      ['FACT', table(100, { ORDER_ID: col(2), QTY: col(50) })],
      ['DIM', table(100, { ORDER_ID: col(100) })],
    ]);
    const plan = pushdown(PUSHABLE, small);

    expect(fired(plan)).toBe(false);
  });
});

describe('AggregatePushdown declines what it cannot decompose', () => {
  const cases = {
    'DISTINCT aggregates': `
      SELECT f.ORDER_ID AS K, COUNT(DISTINCT f.QTY) AS N
      FROM FACT f JOIN DIM d ON d.ORDER_ID = f.ORDER_ID GROUP BY f.ORDER_ID`,
    'AVG, whose partial needs two columns': `
      SELECT f.ORDER_ID AS K, AVG(f.QTY) AS A
      FROM FACT f JOIN DIM d ON d.ORDER_ID = f.ORDER_ID GROUP BY f.ORDER_ID`,
    'an outer join': `
      SELECT f.ORDER_ID AS K, SUM(f.QTY) AS TOTAL
      FROM FACT f LEFT JOIN DIM d ON d.ORDER_ID = f.ORDER_ID GROUP BY f.ORDER_ID`,
    'a group-by spanning both sides': `
      SELECT f.ORDER_ID AS K, d.STATUS AS S, SUM(f.QTY) AS TOTAL
      FROM FACT f JOIN DIM d ON d.ORDER_ID = f.ORDER_ID GROUP BY f.ORDER_ID, d.STATUS`,
    'an aggregate reading the other side': `
      SELECT f.ORDER_ID AS K, MIN(d.STATUS) AS S
      FROM FACT f JOIN DIM d ON d.ORDER_ID = f.ORDER_ID GROUP BY f.ORDER_ID`,
  };

  for (const [name, sql] of Object.entries(cases)) {
    it(`declines ${name}`, () => {
      expect(fired(pushdown(sql))).toBe(false);
    });
  }
});
