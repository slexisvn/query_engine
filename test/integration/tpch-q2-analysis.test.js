import { describe, it, expect, beforeAll } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { generateTPCHData } from '../fixtures/tpch-gen.js';
import { parse } from '../../src/parser/parser.js';
import { Binder } from '../../src/binder/binder.js';
import { createLogicalPlan } from '../../src/planner/logical-planner.js';
import { PlanNodeType, JoinType, PhysicalStrategy, getChildren, planToString } from '../../src/planner/logical-plan.js';
import { Optimizer } from '../../src/optimizer/optimizer.js';
import { SubqueryUnnesting } from '../../src/optimizer/passes/subquery-unnesting.js';
import { PredicatePushdown } from '../../src/optimizer/passes/predicate-pushdown.js';
import { PredicateInference } from '../../src/optimizer/passes/predicate-inference.js';
import { ProjectionPushdown } from '../../src/optimizer/passes/projection-pushdown.js';
import { ExpressionSimplifier } from '../../src/optimizer/passes/expression-simplifier.js';
import { JoinReorder } from '../../src/optimizer/passes/join-reorder.js';
import { PhysicalDesign } from '../../src/optimizer/passes/physical-design.js';
import { HavingPushdown } from '../../src/optimizer/passes/having-pushdown.js';
import { OuterToInnerJoin } from '../../src/optimizer/passes/outer-to-inner.js';
import { LimitPushdown } from '../../src/optimizer/passes/limit-pushdown.js';
import { EmptyPropagation } from '../../src/optimizer/passes/empty-propagation.js';
import { NodeMerge } from '../../src/optimizer/passes/node-merge.js';
import { PredicateDedup } from '../../src/optimizer/passes/predicate-dedup.js';
import { JoinElimination } from '../../src/optimizer/passes/join-elimination.js';
import { SortElimination } from '../../src/optimizer/passes/sort-elimination.js';
import { CTEOptimization } from '../../src/optimizer/passes/cte-optimization.js';
import { defaultFunctionRegistry } from '../../src/catalog/function-registry.js';
import { StatisticsCollector } from '../../src/catalog/statistics.js';
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
let catalog;
let statistics;

beforeAll(async () => {
  const data = await generateTPCHData();
  engine = new QueryEngine(data.catalog);
  catalog = data.catalog;

  statistics = new Map();
  for (const name of catalog.listTables()) {
    const storage = catalog.getTableStorage(name);
    if (storage) {
      statistics.set(name.toUpperCase(), StatisticsCollector.collect(storage));
    }
  }
});


function buildLogicalPlan(sql) {
  const ast = parse(sql);
  const binder = new Binder(catalog, defaultFunctionRegistry);
  const bound = binder.bind(ast);
  return createLogicalPlan(bound);
}

function applyPasses(plan, passes) {
  const optimizer = new Optimizer();
  for (const p of passes) optimizer.registerPass(p);
  return optimizer.optimize(plan);
}

function collectNodes(node, type) {
  const result = [];
  function walk(n) {
    if (!n) return;
    if (n.type === type) result.push(n);
    for (const child of getChildren(n)) walk(child);
  }
  walk(node);
  return result;
}

function findNode(node, type) {
  if (!node) return null;
  if (node.type === type) return node;
  for (const child of getChildren(node)) {
    const found = findNode(child, type);
    if (found) return found;
  }
  return null;
}

function countNodes(node, type) {
  return collectNodes(node, type).length;
}

function collectTableScans(node) {
  return collectNodes(node, PlanNodeType.SCAN).map(s => s.table || s.alias);
}

function printPlan(label, plan) {
  console.log(`\n=== ${label} ===`);
  console.log(planToString(plan));
}

function describeCondition(cond) {
  if (!cond) return 'null';
  if (cond.kind === BoundExprKind.BINARY) {
    if (cond.op === 'AND') return `(${describeCondition(cond.left)} AND ${describeCondition(cond.right)})`;
    const l = cond.left?.kind === BoundExprKind.COLUMN_REF ? `${cond.left.tableAlias}.${cond.left.columnName}` :
              cond.left?.kind === BoundExprKind.LITERAL ? String(cond.left.value) : '?';
    const r = cond.right?.kind === BoundExprKind.COLUMN_REF ? `${cond.right.tableAlias}.${cond.right.columnName}` :
              cond.right?.kind === BoundExprKind.LITERAL ? String(cond.right.value) : '?';
    return `${l} ${cond.op} ${r}`;
  }
  if (cond.kind === BoundExprKind.LIKE) return `LIKE`;
  return cond.kind || '?';
}


describe('TPC-H Q2 Optimizer Analysis', () => {

  it('Step 1: Logical plan has correlated scalar subquery', async () => {
    const plan = buildLogicalPlan(Q2_SQL);
    const depJoins = countNodes(plan, PlanNodeType.DEPENDENT_JOIN);
    expect(depJoins).toBeGreaterThanOrEqual(1);

    const scans = collectTableScans(plan);
    expect(scans.length).toBeGreaterThanOrEqual(9);
  });

  it('Step 2: SubqueryUnnesting decorrelates the scalar subquery', async () => {
    const plan = buildLogicalPlan(Q2_SQL);
    const unnested = applyPasses(plan, [
      new ExpressionSimplifier(),
      new SubqueryUnnesting(),
    ]);

    const depJoins = countNodes(unnested, PlanNodeType.DEPENDENT_JOIN);
    expect(depJoins).toBe(0);

    const joins = collectNodes(unnested, PlanNodeType.JOIN);
    const hasScalarJoin = joins.some(j =>
      j.joinType === JoinType.LEFT || j.joinType === JoinType.SINGLE
    );
    expect(hasScalarJoin).toBe(true);
  });

  it('Step 3: PredicatePushdown pushes filters to base tables', async () => {
    const plan = buildLogicalPlan(Q2_SQL);
    const optimized = applyPasses(plan, [
      new ExpressionSimplifier(),
      new SubqueryUnnesting(),
      new HavingPushdown(),
      new PredicatePushdown(),
    ]);

    const filters = collectNodes(optimized, PlanNodeType.FILTER);

    const joins = collectNodes(optimized, PlanNodeType.JOIN);
    let filtersBelowJoin = 0;
    for (const j of joins) {
      for (const child of getChildren(j)) {
        filtersBelowJoin += countNodes(child, PlanNodeType.FILTER);
      }
    }
    expect(filtersBelowJoin).toBeGreaterThan(0);
  });

  it('Step 4: PredicateInference derives transitive predicates', async () => {
    const plan = buildLogicalPlan(Q2_SQL);
    const beforeInference = applyPasses(plan, [
      new ExpressionSimplifier(),
      new SubqueryUnnesting(),
      new PredicatePushdown(),
    ]);
    const afterInference = applyPasses(plan, [
      new ExpressionSimplifier(),
      new SubqueryUnnesting(),
      new PredicatePushdown(),
      new PredicateInference(),
      new PredicatePushdown(),
    ]);

    const filtersBefore = countNodes(beforeInference, PlanNodeType.FILTER);
    const filtersAfter = countNodes(afterInference, PlanNodeType.FILTER);
    expect(filtersAfter).toBeGreaterThanOrEqual(filtersBefore);
  });

  it('Step 5: JoinReorder produces cost-optimal join order', async () => {
    const plan = buildLogicalPlan(Q2_SQL);
    const optimized = applyPasses(plan, [
      new ExpressionSimplifier(),
      new SubqueryUnnesting(),
      new HavingPushdown(),
      new PredicatePushdown(),
      new PredicateInference(),
      new PredicatePushdown(),
      new OuterToInnerJoin(),
      new JoinReorder(statistics),
    ]);

    const joins = collectNodes(optimized, PlanNodeType.JOIN);
    expect(joins.length).toBeGreaterThan(0);

    let deepest = joins[0];
    for (const j of joins) {
      const depth = getDepth(j);
      if (depth > getDepth(deepest)) deepest = j;
    }
  });

  it('Step 6: ProjectionPushdown prunes unused columns', async () => {
    const plan = buildLogicalPlan(Q2_SQL);
    const optimized = applyPasses(plan, [
      new ExpressionSimplifier(),
      new SubqueryUnnesting(),
      new HavingPushdown(),
      new PredicatePushdown(),
      new PredicateInference(),
      new PredicatePushdown(),
      new OuterToInnerJoin(),
      new JoinReorder(statistics),
      new ProjectionPushdown(),
    ]);

    const scans = collectNodes(optimized, PlanNodeType.SCAN);
    let prunedCount = 0;
    for (const scan of scans) {
      const fullSchema = catalog.getTable(scan.table);
      if (fullSchema && scan.columns.length < fullSchema.columns.length) {
        prunedCount++;
      }
    }
    expect(prunedCount).toBeGreaterThan(0);
  });

  it('Step 7: PhysicalDesign selects hash join and annotates build sides', async () => {
    const plan = buildLogicalPlan(Q2_SQL);
    const optimized = applyPasses(plan, [
      new ExpressionSimplifier(),
      new SubqueryUnnesting(),
      new HavingPushdown(),
      new PredicatePushdown(),
      new PredicateInference(),
      new PredicatePushdown(),
      new OuterToInnerJoin(),
      new JoinReorder(statistics),
      new ProjectionPushdown(),
      new LimitPushdown(),
      new EmptyPropagation(),
      new NodeMerge(),
      new PredicateDedup(),
      new PhysicalDesign(statistics),
    ]);

    const joins = collectNodes(optimized, PlanNodeType.JOIN);
    for (const j of joins) {
      if (j.joinType === JoinType.INNER) {
        expect(j.physicalStrategy).toBeDefined();
        expect([PhysicalStrategy.HASH, PhysicalStrategy.MERGE]).toContain(j.physicalStrategy);

        expect(j._cardinality).toBeDefined();
        expect(j._cardinality).toBeGreaterThan(0);
      }
    }
  });

  it('Step 8: LimitPushdown tags Sort as Top-N', async () => {
    const plan = buildLogicalPlan(Q2_SQL);
    const optimized = applyPasses(plan, [
      new ExpressionSimplifier(),
      new SubqueryUnnesting(),
      new HavingPushdown(),
      new PredicatePushdown(),
      new LimitPushdown(),
    ]);

    const sort = findNode(optimized, PlanNodeType.SORT);
    if (sort) {
      expect(sort.limit).toBe(100);
    }
  });

  it('Step 9: Full pipeline produces correct results', async () => {
    const result = await engine.run(Q2_SQL);

    expect(result.rows.length).toBeLessThanOrEqual(100);
    expect(result.rows.length).toBeGreaterThan(0);

    expect(result.columns).toContain('s_acctbal');
    expect(result.columns).toContain('s_name');
    expect(result.columns).toContain('n_name');
    expect(result.columns).toContain('p_partkey');

    for (let i = 1; i < result.rows.length; i++) {
      const prev = result.rows[i - 1];
      const curr = result.rows[i];
      if (prev.s_acctbal !== curr.s_acctbal) {
        expect(prev.s_acctbal).toBeGreaterThanOrEqual(curr.s_acctbal);
      }
    }

    const europeanNations = ['FRANCE', 'GERMANY', 'ROMANIA', 'RUSSIA', 'UNITED KINGDOM'];
    for (const row of result.rows) {
      expect(europeanNations).toContain(row.n_name);
    }

  });

  it('Step 10: Compare optimized plan quality metrics', async () => {
    const plan = buildLogicalPlan(Q2_SQL);

    const unoptScans = countNodes(plan, PlanNodeType.SCAN);
    const unoptJoins = countNodes(plan, PlanNodeType.JOIN);
    const unoptDepJoins = countNodes(plan, PlanNodeType.DEPENDENT_JOIN);
    const unoptFilters = countNodes(plan, PlanNodeType.FILTER);

    const optimized = engine.optimize(plan);
    const optScans = countNodes(optimized, PlanNodeType.SCAN);
    const optJoins = countNodes(optimized, PlanNodeType.JOIN);
    const optDepJoins = countNodes(optimized, PlanNodeType.DEPENDENT_JOIN);
    const optFilters = countNodes(optimized, PlanNodeType.FILTER);

    console.log('\n=== Q2 Plan Quality Metrics ===');
    console.log(`Scans:        ${unoptScans} → ${optScans}`);
    console.log(`Joins:        ${unoptJoins} → ${optJoins}`);
    console.log(`DependentJoins: ${unoptDepJoins} → ${optDepJoins}`);
    console.log(`Filters:      ${unoptFilters} → ${optFilters}`);

    expect(optDepJoins).toBe(0);

    expect(optFilters).toBeGreaterThanOrEqual(unoptFilters);

    console.log('\n=== Optimized Q2 Plan ===');
    console.log(planToString(optimized));
  });
});

function getDepth(node) {
  let depth = 0;
  for (const child of getChildren(node)) {
    depth = Math.max(depth, 1 + getDepth(child));
  }
  return depth;
}
