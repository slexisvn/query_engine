import { describe, it, expect } from 'vitest';
import '../../src/index.js';
import { createEngine, registerTable } from '../../src/engine-entry.js';
import { OptimizationPass } from '../../src/optimizer/pass.js';
import { PlanRewriter } from '../../src/planner/plan-rewriter.js';
import { PlanNodeType, JoinType, LogicalAggregate } from '../../src/planner/logical-plan.js';
import { BoundColumnRef } from '../../src/binder/expression-binder.js';
import { DataType } from '../../src/storage/data-type.js';
import { ColumnStatistics, TableStatistics } from '../../src/catalog/statistics.js';

const SALES_SCHEMA = [
  { name: 'ID', dataType: DataType.INT32 },
  { name: 'REGION_CODE', dataType: DataType.VARCHAR },
  { name: 'PRODUCT', dataType: DataType.VARCHAR },
  { name: 'QTY', dataType: DataType.INT32 },
  { name: 'AMOUNT', dataType: DataType.INT32 },
  { name: 'NOTE', dataType: DataType.VARCHAR },
];

const REGIONS_SCHEMA = [
  { name: 'REGION_CODE', dataType: DataType.VARCHAR },
  { name: 'REGION_NAME', dataType: DataType.VARCHAR },
  { name: 'NOTE', dataType: DataType.VARCHAR },
];

const SALES = [
  { ID: 1, REGION_CODE: 'NA', PRODUCT: 'widget', QTY: 2, AMOUNT: 100, NOTE: 'sale-a' },
  { ID: 2, REGION_CODE: 'NA', PRODUCT: 'widget', QTY: null, AMOUNT: 50, NOTE: 'sale-b' },
  { ID: 3, REGION_CODE: 'EU', PRODUCT: 'widget', QTY: 4, AMOUNT: null, NOTE: 'sale-c' },
  { ID: 4, REGION_CODE: 'EU', PRODUCT: 'gadget', QTY: 1, AMOUNT: 200, NOTE: 'sale-d' },
  { ID: 5, REGION_CODE: 'APAC', PRODUCT: 'gadget', QTY: 3, AMOUNT: 76, NOTE: 'sale-e' },
  { ID: 6, REGION_CODE: null, PRODUCT: 'gizmo', QTY: 5, AMOUNT: 500, NOTE: 'sale-f' },
  { ID: 7, REGION_CODE: 'ZZ', PRODUCT: 'gizmo', QTY: 1, AMOUNT: 25, NOTE: 'sale-g' },
];

const REGIONS = [
  { REGION_CODE: 'NA', REGION_NAME: 'north america', NOTE: 'region-a' },
  { REGION_CODE: 'EU', REGION_NAME: 'europe', NOTE: 'region-b' },
  { REGION_CODE: 'EU', REGION_NAME: 'europe west', NOTE: 'region-c' },
  { REGION_CODE: 'APAC', REGION_NAME: 'asia pacific', NOTE: 'region-d' },
  { REGION_CODE: 'MEA', REGION_NAME: 'middle east', NOTE: 'region-e' },
  { REGION_CODE: null, REGION_NAME: 'unknown', NOTE: 'region-f' },
];

const JOINED = SALES.flatMap(s =>
  REGIONS.filter(r => s.REGION_CODE !== null && r.REGION_CODE === s.REGION_CODE).map(r => ({ s, r })));

const defined = values => values.filter(value => value !== null);
const sum = values => (defined(values).length === 0 ? null : defined(values).reduce((a, b) => a + b, 0));
const count = values => defined(values).length;
const countDistinct = values => new Set(defined(values)).size;
const min = values => (defined(values).length === 0 ? null : defined(values).reduce((a, b) => (a <= b ? a : b)));
const max = values => (defined(values).length === 0 ? null : defined(values).reduce((a, b) => (a >= b ? a : b)));
const avg = values => (defined(values).length === 0 ? null : sum(values) / count(values));

function groupsOf(keyOf) {
  const groups = new Map();
  for (const pair of JOINED) {
    const key = JSON.stringify(keyOf(pair));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pair);
  }
  return [...groups.values()];
}

function expectedRows(keyOf, rowOf) {
  return groupsOf(keyOf).map(group => rowOf(group));
}

const byProduct = pair => pair.s.PRODUCT;
const byRegionName = pair => pair.r.REGION_NAME;

const SUM_WITHOUT_JOIN_KEY = {
  name: 'SUM grouped by a column the join key is absent from',
  sql: 'SELECT s.PRODUCT AS P, SUM(s.AMOUNT) AS TOTAL FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.PRODUCT',
  expected: () => expectedRows(byProduct, g => ({ P: g[0].s.PRODUCT, TOTAL: sum(g.map(p => p.s.AMOUNT)) })),
};

const ORDER_BY_AGGREGATE = {
  name: 'ORDER BY reads the aggregate back out of the group',
  sql: 'SELECT s.PRODUCT AS P, SUM(s.AMOUNT) AS TOTAL FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.PRODUCT ORDER BY SUM(s.AMOUNT) DESC',
  expected: () => expectedRows(byProduct, g => ({ P: g[0].s.PRODUCT, TOTAL: sum(g.map(p => p.s.AMOUNT)) })),
};

const CORPUS = [
  SUM_WITHOUT_JOIN_KEY,
  {
    name: 'COUNT(*) counts joined rows, not source rows',
    sql: 'SELECT s.PRODUCT AS P, COUNT(*) AS N FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.PRODUCT',
    expected: () => expectedRows(byProduct, g => ({ P: g[0].s.PRODUCT, N: g.length })),
  },
  {
    name: 'COUNT of a nullable column skips NULLs on every duplicated row',
    sql: 'SELECT s.PRODUCT AS P, COUNT(s.QTY) AS N FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.PRODUCT',
    expected: () => expectedRows(byProduct, g => ({ P: g[0].s.PRODUCT, N: count(g.map(p => p.s.QTY)) })),
  },
  {
    name: 'MIN and MAX over a join that duplicates rows',
    sql: 'SELECT s.PRODUCT AS P, MIN(s.AMOUNT) AS LO, MAX(s.AMOUNT) AS HI FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.PRODUCT',
    expected: () => expectedRows(byProduct, g => ({
      P: g[0].s.PRODUCT,
      LO: min(g.map(p => p.s.AMOUNT)),
      HI: max(g.map(p => p.s.AMOUNT)),
    })),
  },
  {
    name: 'AVG counts every duplicate the join produced',
    sql: 'SELECT s.PRODUCT AS P, AVG(s.AMOUNT) AS MEAN FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.PRODUCT',
    expected: () => expectedRows(byProduct, g => ({ P: g[0].s.PRODUCT, MEAN: avg(g.map(p => p.s.AMOUNT)) })),
  },
  {
    name: 'group-by is the join key itself',
    sql: 'SELECT s.REGION_CODE AS C, SUM(s.AMOUNT) AS TOTAL, COUNT(*) AS N FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.REGION_CODE',
    expected: () => expectedRows(pair => pair.s.REGION_CODE, g => ({
      C: g[0].s.REGION_CODE,
      TOTAL: sum(g.map(p => p.s.AMOUNT)),
      N: g.length,
    })),
  },
  {
    name: 'group-by sits on the side the aggregate does not read',
    sql: 'SELECT r.REGION_NAME AS RN, SUM(s.AMOUNT) AS TOTAL FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY r.REGION_NAME',
    expected: () => expectedRows(byRegionName, g => ({ RN: g[0].r.REGION_NAME, TOTAL: sum(g.map(p => p.s.AMOUNT)) })),
  },
  {
    name: 'group-by spans both join sides',
    sql: 'SELECT s.PRODUCT AS P, r.REGION_NAME AS RN, COUNT(*) AS N FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.PRODUCT, r.REGION_NAME',
    expected: () => expectedRows(pair => [pair.s.PRODUCT, pair.r.REGION_NAME], g => ({
      P: g[0].s.PRODUCT,
      RN: g[0].r.REGION_NAME,
      N: g.length,
    })),
  },
  {
    name: 'COUNT DISTINCT collapses the duplicates the join introduced',
    sql: 'SELECT r.REGION_NAME AS RN, COUNT(DISTINCT s.PRODUCT) AS N FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY r.REGION_NAME',
    expected: () => expectedRows(byRegionName, g => ({
      RN: g[0].r.REGION_NAME,
      N: countDistinct(g.map(p => p.s.PRODUCT)),
    })),
  },
  {
    name: 'HAVING filters on the aggregate computed above the join',
    sql: 'SELECT s.PRODUCT AS P, SUM(s.AMOUNT) AS TOTAL FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.PRODUCT HAVING SUM(s.AMOUNT) > 150',
    expected: () => expectedRows(byProduct, g => ({ P: g[0].s.PRODUCT, TOTAL: sum(g.map(p => p.s.AMOUNT)) }))
      .filter(row => row.TOTAL !== null && row.TOTAL > 150),
  },
  ORDER_BY_AGGREGATE,
  {
    name: 'a column name both tables carry resolves to the qualified side',
    sql: 'SELECT r.NOTE AS RIGHT_NOTE, COUNT(*) AS N FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY r.NOTE',
    expected: () => expectedRows(pair => pair.r.NOTE, g => ({ RIGHT_NOTE: g[0].r.NOTE, N: g.length })),
  },
  {
    name: 'the same name on the other side resolves there instead',
    sql: 'SELECT s.NOTE AS LEFT_NOTE, COUNT(*) AS N FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE GROUP BY s.NOTE',
    expected: () => expectedRows(pair => pair.s.NOTE, g => ({ LEFT_NOTE: g[0].s.NOTE, N: g.length })),
  },
];

const EAGER_ELIGIBLE = new Set([
  'SUM grouped by a column the join key is absent from',
  'COUNT(*) counts joined rows, not source rows',
  'COUNT of a nullable column skips NULLs on every duplicated row',
  'MIN and MAX over a join that duplicates rows',
  'group-by is the join key itself',
  'HAVING filters on the aggregate computed above the join',
  'ORDER BY reads the aggregate back out of the group',
  'the same name on the other side resolves there instead',
]);

function seed(engine) {
  registerTable(engine, 'SALES', SALES, SALES_SCHEMA);
  registerTable(engine, 'REGIONS', REGIONS, REGIONS_SCHEMA);
  return engine;
}

function normalize(rows) {
  return rows.map(row => JSON.stringify(row)).sort();
}

function scanAliases(node, aliases = new Set()) {
  if (!node) return aliases;
  if (node.type === PlanNodeType.SCAN) aliases.add((node.alias || node.table || '').toUpperCase());
  for (const child of node.children || []) scanAliases(child, aliases);
  return aliases;
}

class DropJoinKeyRewriter extends PlanRewriter {
  constructor(alias, columns) {
    super();
    this.alias = alias;
    this.columns = columns;
  }

  rewriteJoin(node) {
    const rewritten = this.rewriteChildren(node);
    if (rewritten.joinType !== JoinType.INNER) return rewritten;

    const side = rewritten.children.findIndex(input => scanAliases(input).has(this.alias));
    if (side === -1) return rewritten;

    const groupBy = this.columns.map((column, index) =>
      BoundColumnRef(this.alias, column, index, DataType.VARCHAR));
    const children = [...rewritten.children];
    children[side] = LogicalAggregate(groupBy, [], children[side]);
    return { ...rewritten, children };
  }
}

class GroupJoinInputWithoutJoinKey extends OptimizationPass {
  get name() { return 'GroupJoinInputWithoutJoinKey'; }
  apply(plan) { return new DropJoinKeyRewriter('S', ['PRODUCT']).rewrite(plan); }
}

function engineWithMutation() {
  const engine = createEngine();
  const build = engine.createOptimizer.bind(engine);
  engine.createOptimizer = statistics => build(statistics).registerPass(new GroupJoinInputWithoutJoinKey());
  engine.optimizer = engine.createOptimizer(engine.precomputedStats);
  return seed(engine);
}

async function rowsFor(engine, sql) {
  const result = await engine.run(sql);
  return result.rows;
}

describe('aggregate over join matches an independent oracle', () => {
  for (const entry of CORPUS) {
    it(entry.name, async () => {
      const engine = seed(createEngine());
      const rows = await rowsFor(engine, entry.sql);
      engine.close();

      const expected = entry.expected();
      expect(normalize(rows)).toEqual(normalize(expected));
      expect(expected.length).toBeGreaterThan(0);
    });
  }

  it('orders by the aggregate rather than returning the groups in any order', async () => {
    const engine = seed(createEngine());
    const rows = await rowsFor(engine, ORDER_BY_AGGREGATE.sql);
    engine.close();

    expect(rows.map(row => row.P)).toEqual([...ORDER_BY_AGGREGATE.expected()]
      .sort((a, b) => (b.TOTAL ?? -Infinity) - (a.TOTAL ?? -Infinity))
      .map(row => row.P));
  });
});

describe('the corpus exercises the shapes an aggregate rewrite has to survive', () => {
  it('joins on a key one side repeats, so the join duplicates rows', () => {
    const duplicated = JOINED.filter(pair => pair.s.REGION_CODE === 'EU');
    expect(duplicated.length).toBeGreaterThan(SALES.filter(s => s.REGION_CODE === 'EU').length);
  });

  it('keeps NULL join keys on both sides out of the join', () => {
    expect(SALES.some(s => s.REGION_CODE === null)).toBe(true);
    expect(REGIONS.some(r => r.REGION_CODE === null)).toBe(true);
    expect(JOINED.every(pair => pair.s.REGION_CODE !== null && pair.r.REGION_CODE !== null)).toBe(true);
  });

  it('groups by columns the join key is absent from', () => {
    expect(SUM_WITHOUT_JOIN_KEY.sql).toContain('GROUP BY s.PRODUCT');
    expect(SUM_WITHOUT_JOIN_KEY.sql).not.toContain('GROUP BY s.REGION_CODE');
  });

  it('gives both tables a column of the same name', () => {
    expect(SALES_SCHEMA.some(column => REGIONS_SCHEMA.some(other => other.name === column.name && column.name !== 'REGION_CODE')))
      .toBe(true);
  });
});

function statsColumn(ndv) {
  return new ColumnStatistics({ ndv, min: 0, max: ndv });
}

function statsTable(rowCount, columns) {
  const map = new Map();
  for (const [name, stats] of Object.entries(columns)) map.set(name, stats);
  return new TableStatistics(rowCount, map);
}

function warehouseScaleStatistics() {
  return new Map([
    ['SALES', statsTable(6000000, {
      ID: statsColumn(6000000), REGION_CODE: statsColumn(4), PRODUCT: statsColumn(3),
      QTY: statsColumn(5), AMOUNT: statsColumn(6), NOTE: statsColumn(7),
    })],
    ['REGIONS', statsTable(6, {
      REGION_CODE: statsColumn(4), REGION_NAME: statsColumn(6), NOTE: statsColumn(6),
    })],
  ]);
}

function planHas(node, type) {
  if (!node) return false;
  if (node.type === type) return true;
  return (node.children || []).some(child => planHas(child, type));
}

describe('eager aggregation preserves every answer once the cost gate lets it fire', () => {
  for (const entry of CORPUS) {
    it(entry.name, async () => {
      const engine = seed(createEngine({ statistics: warehouseScaleStatistics() }));
      const compiled = await engine.compile(entry.sql);
      const rows = await rowsFor(engine, entry.sql);
      engine.close();

      expect(normalize(rows)).toEqual(normalize(entry.expected()));
      expect(planHas(compiled.plan, PlanNodeType.PARTIAL_AGGREGATE))
        .toBe(EAGER_ELIGIBLE.has(entry.name));
    });
  }

  it('leaves the aggregate alone when the tables are genuinely small', async () => {
    const engine = seed(createEngine());
    const compiled = await engine.compile(SUM_WITHOUT_JOIN_KEY.sql);
    engine.close();

    expect(planHas(compiled.plan, PlanNodeType.PARTIAL_AGGREGATE)).toBe(false);
  });
});

const PROJECTION_ONLY = 'SELECT s.PRODUCT AS P, r.REGION_NAME AS RN FROM SALES s JOIN REGIONS r ON r.REGION_CODE = s.REGION_CODE';

describe('a join input regrouped without its join key is caught, not tolerated', () => {
  it('silently becomes a cross product when nothing above reports the loss', async () => {
    const engine = engineWithMutation();
    const mutated = await rowsFor(engine, PROJECTION_ONLY);
    engine.close();

    const honest = seed(createEngine());
    const correct = await rowsFor(honest, PROJECTION_ONLY);
    honest.close();

    const pairs = rows => new Set(rows.map(row => `${row.P}|${row.RN}`));
    expect(pairs(correct).has('widget|asia pacific')).toBe(false);
    expect(pairs(mutated).has('widget|asia pacific')).toBe(true);
    expect(normalize(mutated)).not.toEqual(normalize(correct));
  });

  it('is caught by the corpus once an aggregate sits above the join', async () => {
    const engine = engineWithMutation();
    await expect(rowsFor(engine, SUM_WITHOUT_JOIN_KEY.sql)).rejects.toThrow(/S\.AMOUNT/);
    engine.close();
  });

  it('keeps the mutating pass registered after statistics are collected', async () => {
    const engine = engineWithMutation();
    await rowsFor(engine, 'SELECT COUNT(*) AS N FROM SALES');
    const passes = engine.optimizer.listPasses();
    engine.close();

    expect(passes).toContain('GroupJoinInputWithoutJoinKey');
  });
});
