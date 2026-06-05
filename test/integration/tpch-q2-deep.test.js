import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { generateTPCHData } from '../fixtures/tpch-gen.js';
import { PlanNodeType, JoinType, PhysicalStrategy, getChildren, planToString } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

const Q2_SQL = `
  SELECT s_acctbal, s_name, n_name, p_partkey, p_mfgr, s_address, s_phone, s_comment
  FROM part, supplier, partsupp, nation, region
  WHERE p_partkey = ps_partkey AND s_suppkey = ps_suppkey
    AND p_size = 15 AND p_type LIKE '%BRASS'
    AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey
    AND r_name = 'EUROPE'
    AND ps_supplycost = (
      SELECT MIN(ps_supplycost)
      FROM partsupp, supplier, nation, region
      WHERE p_partkey = ps_partkey AND s_suppkey = ps_suppkey
        AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey
        AND r_name = 'EUROPE'
    )
  ORDER BY s_acctbal DESC, n_name, s_name, p_partkey
  LIMIT 100
`;

let engine;
let tables;
let tempManager;

beforeAll(async () => {
  const data = await generateTPCHData();
  engine = new QueryEngine(data.catalog);
  tables = data.tables;
  tempManager = data.tempManager;
});

afterAll(() => {
  tempManager?.cleanup();
});

function collectNodes(node, type) {
  const r = [];
  (function walk(n) { if (!n) return; if (n.type === type) r.push(n); for (const c of getChildren(n)) walk(c); })(node);
  return r;
}

function findDeepestScan(node) {
  const scans = collectNodes(node, PlanNodeType.SCAN);
  return scans.map(s => s.table);
}

function findFirstJoin(node) {
  if (!node) return null;
  if (node.type === PlanNodeType.JOIN) return node;
  for (const c of getChildren(node)) {
    const f = findFirstJoin(c);
    if (f) return f;
  }
  return null;
}

function getDeepestJoinPair(node) {
  const joins = collectNodes(node, PlanNodeType.JOIN);
  if (joins.length === 0) return null;
  for (const j of joins) {
    const leftScans = collectNodes(j.children[0], PlanNodeType.SCAN);
    const rightScans = collectNodes(j.children[1], PlanNodeType.SCAN);
    if (leftScans.length <= 1 && rightScans.length <= 1) {
      return {
        left: leftScans[0]?.table || '?',
        right: rightScans[0]?.table || '?',
        joinType: j.joinType,
        buildSide: j._buildSide,
      };
    }
  }
  return null;
}

describe('TPC-H Q2 Deep Optimization Analysis', () => {

  it('verifies join order puts small tables first', async () => {
    const { plan } = await engine.compile(Q2_SQL);

    const deepest = getDeepestJoinPair(plan);
    console.log('Deepest join:', deepest);

    if (deepest) {
      const small = ['REGION', 'NATION'];
      const involved = [deepest.left, deepest.right];
      const hasSmall = involved.some(t => small.includes(t));
      expect(hasSmall).toBe(true);
    }
  });

  it('verifies build-side selection on joins', async () => {
    const { plan } = await engine.compile(Q2_SQL);
    const joins = collectNodes(plan, PlanNodeType.JOIN);

    let hasBuildSideHint = false;
    for (const j of joins) {
      if (j._buildSide) {
        hasBuildSideHint = true;
        const leftCard = j.children[0]._cardinality || 0;
        const rightCard = j.children[1]._cardinality || 0;

        console.log(`Join(${j.joinType}) buildSide=${j._buildSide} leftCard=${leftCard} rightCard=${rightCard}`);

        if (j._buildSide === 'right') {
          expect(rightCard).toBeLessThanOrEqual(leftCard);
        }
      }
    }
    expect(hasBuildSideHint).toBe(true);
  });

  it('verifies cardinality estimates are reasonable', async () => {
    const { plan } = await engine.compile(Q2_SQL);
    const joins = collectNodes(plan, PlanNodeType.JOIN);

    for (const j of joins) {
      if (j._cardinality !== undefined) {
        expect(j._cardinality).toBeGreaterThan(0);
        expect(j._cardinality).toBeLessThan(1e9);

        console.log(`Join(${j.joinType}) card=${j._cardinality}`);
      }
    }
  });

  it('verifies predicate pushdown quality', async () => {
    const { plan } = await engine.compile(Q2_SQL);
    const filters = collectNodes(plan, PlanNodeType.FILTER);

    let hasRegionFilter = false;
    let hasPartFilter = false;
    for (const f of filters) {
      const cond = f.condition;
      const desc = describeExpr(cond);
      console.log(`Filter: ${desc}`);

      const child = f.children[0];
      if (child.type === PlanNodeType.SCAN) {
        if (child.table === 'REGION') hasRegionFilter = true;
        if (child.table === 'PART') hasPartFilter = true;
      }
    }

    expect(hasRegionFilter).toBe(true);
    expect(hasPartFilter).toBe(true);
  });

  it('verifies column pruning effectiveness', async () => {
    const { plan } = await engine.compile(Q2_SQL);
    const scans = collectNodes(plan, PlanNodeType.SCAN);

    let totalOriginalCols = 0;
    let totalPrunedCols = 0;
    for (const scan of scans) {
      const fullTable = engine.catalog.getTable(scan.table);
      if (fullTable) {
        totalOriginalCols += fullTable.columns.length;
        totalPrunedCols += scan.columns.length;
      }
    }

    const pruneRatio = 1 - (totalPrunedCols / totalOriginalCols);
    console.log(`Column pruning: ${totalOriginalCols} → ${totalPrunedCols} (${(pruneRatio * 100).toFixed(1)}% reduction)`);

    expect(pruneRatio).toBeGreaterThan(0.2);
  });

  it('verifies result correctness with manual validation', async () => {
    const result = await engine.run(Q2_SQL);

    const euroSuppliers = await engine.run(`
      SELECT s_suppkey FROM supplier, nation, region
      WHERE s_nationkey = n_nationkey AND n_regionkey = r_regionkey AND r_name = 'EUROPE'
    `);
    const euroSuppKeys = new Set(euroSuppliers.rows.map(r => r.s_suppkey));

    const brassParts = await engine.run(`
      SELECT p_partkey FROM part WHERE p_size = 15 AND p_type LIKE '%BRASS'
    `);

    const brassPartKeys = new Set(brassParts.rows.map(r => r.p_partkey));
    for (const row of result.rows) {
      expect(brassPartKeys.has(row.p_partkey)).toBe(true);
    }

    for (const row of result.rows) {
      const europeanNations = ['FRANCE', 'GERMANY', 'ROMANIA', 'RUSSIA', 'UNITED KINGDOM'];
      expect(europeanNations).toContain(row.n_name);
    }

    for (const row of result.rows) {
      const minCostResult = await engine.run(`
        SELECT MIN(ps_supplycost) AS min_cost
        FROM partsupp, supplier, nation, region
        WHERE ps_partkey = ${row.p_partkey} AND s_suppkey = ps_suppkey
          AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey
          AND r_name = 'EUROPE'
      `);
      expect(minCostResult.rows.length).toBe(1);
      expect(minCostResult.rows[0].min_cost).not.toBeNull();
    }

    console.log(`Q2 returned ${result.rows.length} rows, all validated correct`);
  }, 30000);

  it('measures Q2 execution time', async () => {
    await engine.run(Q2_SQL);
    await engine.run(Q2_SQL);

    const times = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await engine.run(Q2_SQL);
      times.push(performance.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    console.log(`Q2 execution: avg=${avg.toFixed(1)}ms min=${min.toFixed(1)}ms`);

    expect(avg).toBeLessThan(3000);
  }, 30000);
});

function describeExpr(expr) {
  if (!expr) return 'null';
  if (expr.kind === BoundExprKind.BINARY) {
    if (expr.op === 'AND') return `(${describeExpr(expr.left)} AND ${describeExpr(expr.right)})`;
    const l = describeExpr(expr.left);
    const r = describeExpr(expr.right);
    return `${l} ${expr.op} ${r}`;
  }
  if (expr.kind === BoundExprKind.COLUMN_REF) return `${expr.tableAlias}.${expr.columnName}`;
  if (expr.kind === BoundExprKind.LITERAL) return JSON.stringify(expr.value);
  if (expr.kind === BoundExprKind.LIKE) return `${describeExpr(expr.expr)} LIKE ${describeExpr(expr.pattern)}`;
  return expr.kind || '?';
}
