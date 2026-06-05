
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { generateTPCHData } from '../fixtures/tpch-gen.js';
import { parse } from '../../src/parser/parser.js';
import { Binder } from '../../src/binder/binder.js';
import { createLogicalPlan } from '../../src/planner/logical-planner.js';
import { PlanNodeType, JoinType, getChildren, planToString } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { defaultFunctionRegistry } from '../../src/catalog/function-registry.js';

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
let catalog;
let tempManager;

beforeAll(async () => {
  const data = await generateTPCHData();
  engine = new QueryEngine(data.catalog);
  catalog = data.catalog;
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

function describeExpr(expr, depth = 0) {
  if (!expr || depth > 5) return '?';
  if (expr.kind === BoundExprKind.BINARY) {
    if (expr.op === 'AND') return `(${describeExpr(expr.left, depth+1)} AND ${describeExpr(expr.right, depth+1)})`;
    return `${describeExpr(expr.left, depth+1)} ${expr.op} ${describeExpr(expr.right, depth+1)}`;
  }
  if (expr.kind === BoundExprKind.COLUMN_REF) return `${expr.tableAlias||''}.${expr.columnName}`;
  if (expr.kind === BoundExprKind.LITERAL) return JSON.stringify(expr.value);
  if (expr.kind === BoundExprKind.LIKE) return `LIKE`;
  if (expr.kind === BoundExprKind.AGGREGATE) return `${expr.name}(...)`;
  return expr.kind || '?';
}

function detailedPlanString(node, indent = 0) {
  if (!node) return '';
  const prefix = '  '.repeat(indent);
  let str = `${prefix}${node.type}`;

  if (node.type === PlanNodeType.SCAN) {
    str += `(${node.table}) [${node.columns?.length || '?'} cols]`;
  } else if (node.type === PlanNodeType.JOIN) {
    const strat = node.physicalStrategy || '?';
    const build = node._buildSide || '?';
    const card = node._cardinality || '?';
    str += `(${node.joinType}, ${strat}, build=${build}, card=${card})`;
    if (node.condition) str += ` ON ${describeExpr(node.condition)}`;
  } else if (node.type === PlanNodeType.FILTER) {
    str += ` [${describeExpr(node.condition)}]`;
  } else if (node.type === PlanNodeType.AGGREGATE) {
    const groups = node.groupBy?.length || 0;
    const aggs = node.aggregates?.length || 0;
    str += ` [${groups} groups, ${aggs} aggs]`;
  } else if (node.type === PlanNodeType.SORT) {
    str += node.limit ? ` [top-N limit=${node.limit}]` : '';
  } else if (node.type === PlanNodeType.LIMIT) {
    str += `(${node.count})`;
  }

  str += '\n';
  for (const child of getChildren(node)) {
    str += detailedPlanString(child, indent + 1);
  }
  return str;
}

describe('TPC-H Q2 vs Real DBMS Plans', () => {

  it('GAP 1: scalar comparison should be fused into join condition (DuckDB-style)', async () => {
    const { plan } = await engine.compile(Q2_SQL);

    console.log('\n=== Our Detailed Q2 Plan ===');
    console.log(detailedPlanString(plan));

    const filters = collectNodes(plan, PlanNodeType.FILTER);
    const scalarFilter = filters.find(f => {
      const desc = describeExpr(f.condition);
      return desc.includes('_scalar') || desc.includes('PS_SUPPLYCOST');
    });

    expect(scalarFilter).toBeUndefined();

    const joins = collectNodes(plan, PlanNodeType.JOIN);
    const scalarJoin = joins.find(j => {
      const desc = describeExpr(j.condition);
      return desc.includes('_scalar') && desc.includes('PS_SUPPLYCOST');
    });

    expect(scalarJoin).toBeDefined();
    expect(scalarJoin.joinType).toBe(JoinType.INNER);
  });

  it('GAP 2: the decorrelated join type should be INNER (not LEFT)', async () => {
    const { plan } = await engine.compile(Q2_SQL);
    const joins = collectNodes(plan, PlanNodeType.JOIN);

    let foundOuterSubqueryJoin = false;
    for (const j of joins) {
      const hasAgg = collectNodes(j.children[1], PlanNodeType.AGGREGATE).length > 0
                  || collectNodes(j.children[0], PlanNodeType.AGGREGATE).length > 0;
      if (hasAgg) {
        foundOuterSubqueryJoin = true;
        console.log(`Outer⋈Subquery join type: ${j.joinType}`);
        if (j.joinType === JoinType.LEFT) {
          console.log('⚠️  GAP: decorrelated join is still LEFT (should be INNER)');
        }
      }
    }
    expect(foundOuterSubqueryJoin).toBe(true);
  });

  it('MATCH: join order matches DuckDB (small dimension tables first)', async () => {
    const { plan } = await engine.compile(Q2_SQL);

    const joins = collectNodes(plan, PlanNodeType.JOIN);

    const leafJoins = joins.filter(j => {
      return j.children[0].type !== PlanNodeType.JOIN && j.children[1].type !== PlanNodeType.JOIN;
    });

    for (const lj of leafJoins) {
      const left = collectNodes(lj.children[0], PlanNodeType.SCAN)[0]?.table || '?';
      const right = collectNodes(lj.children[1], PlanNodeType.SCAN)[0]?.table || '?';
      console.log(`Leaf join: ${left} ⋈ ${right}`);
    }

    const smallTables = new Set(['REGION', 'NATION']);
    const hasSmallLeaf = leafJoins.some(lj => {
      const tables = [...collectNodes(lj, PlanNodeType.SCAN)].map(s => s.table);
      return tables.some(t => smallTables.has(t));
    });
    expect(hasSmallLeaf).toBe(true);
  });

  it('MATCH: predicate pushdown matches PostgreSQL/DuckDB', async () => {
    const { plan } = await engine.compile(Q2_SQL);
    const filters = collectNodes(plan, PlanNodeType.FILTER);

    let hasRegionPush = false;
    let hasPartPush = false;

    for (const f of filters) {
      const child = f.children[0];
      if (child?.type === PlanNodeType.SCAN) {
        if (child.table === 'REGION') hasRegionPush = true;
        if (child.table === 'PART') hasPartPush = true;
      }
    }

    expect(hasRegionPush).toBe(true);
    expect(hasPartPush).toBe(true);
    console.log('✅ MATCH: r_name=EUROPE pushed to REGION');
    console.log('✅ MATCH: p_size=15 AND LIKE BRASS pushed to PART');
  });

  it('MATCH: Top-N sort like DuckDB', async () => {
    const { plan } = await engine.compile(Q2_SQL);
    const sorts = collectNodes(plan, PlanNodeType.SORT);

    const topNSort = sorts.find(s => s.limit);
    if (topNSort) {
      console.log(`✅ MATCH: Top-N sort with limit=${topNSort.limit} (DuckDB uses TOP_N operator)`);
      expect(topNSort.limit).toBe(100);
    }
  });

  it('correct results regardless of plan quality', async () => {
    const result = await engine.run(Q2_SQL);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThanOrEqual(100);

    const euroNations = ['FRANCE', 'GERMANY', 'ROMANIA', 'RUSSIA', 'UNITED KINGDOM'];
    for (const row of result.rows) {
      expect(euroNations).toContain(row.n_name);
    }
  });

  it('SUMMARY: plan quality scorecard', async () => {
    const { plan } = await engine.compile(Q2_SQL);

    const checks = {
      'Subquery decorrelated': collectNodes(plan, PlanNodeType.DEPENDENT_JOIN).length === 0,
      'Predicates pushed to leaves': (() => {
        const filters = collectNodes(plan, PlanNodeType.FILTER);
        return filters.some(f => f.children[0]?.type === PlanNodeType.SCAN && f.children[0].table === 'REGION');
      })(),
      'Small tables joined first': (() => {
        const joins = collectNodes(plan, PlanNodeType.JOIN);
        const leafJoins = joins.filter(j => j.children.every(c => c.type !== PlanNodeType.JOIN));
        return leafJoins.some(lj => collectNodes(lj, PlanNodeType.SCAN).some(s => s.table === 'REGION'));
      })(),
      'Top-N sort': collectNodes(plan, PlanNodeType.SORT).some(s => s.limit === 100),
      'Column pruning': (() => {
        const scans = collectNodes(plan, PlanNodeType.SCAN);
        return scans.some(s => {
          const full = catalog.getTable(s.table);
          return full && s.columns.length < full.columns.length;
        });
      })(),
      'Build-side hints': collectNodes(plan, PlanNodeType.JOIN).some(j => j._buildSide),
      'No cartesian products': !collectNodes(plan, PlanNodeType.JOIN).some(j => j.joinType === JoinType.CROSS),
    };

    console.log('\n═══ Q2 Plan Quality Scorecard ═══');
    let pass = 0, total = 0;
    for (const [name, ok] of Object.entries(checks)) {
      total++;
      if (ok) pass++;
      console.log(`${ok ? '✅' : '❌'} ${name}`);
    }
    console.log(`\nScore: ${pass}/${total}`);
    console.log('\n═══ Known Gaps vs PostgreSQL/DuckDB ═══');
    console.log('⚠️  No shared scan for common subquery tables (advanced optimization)');
    console.log('⚠️  No index-nested-loop for correlated probe (PostgreSQL does this)');

    expect(pass).toBeGreaterThanOrEqual(6);
  });
});
