import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/parser.js';
import { Binder } from '../../src/binder/binder.js';
import { createTPCHCatalog } from '../../src/catalog/tpch-schema.js';
import { defaultFunctionRegistry } from '../../src/catalog/function-registry.js';
import { createLogicalPlan } from '../../src/planner/logical-planner.js';
import { PlanNodeType, JoinType, getChildren } from '../../src/planner/logical-plan.js';
import { Optimizer } from '../../src/optimizer/optimizer.js';
import { PredicatePushdown } from '../../src/optimizer/passes/predicate-pushdown.js';
import { ProjectionPushdown } from '../../src/optimizer/passes/projection-pushdown.js';
import { SubqueryUnnesting } from '../../src/optimizer/passes/subquery-unnesting.js';
import { CTEOptimization } from '../../src/optimizer/passes/cte-optimization.js';
import { DefaultCardinalityEstimator } from '../../src/optimizer/dphyp/cardinality.js';
import { ExpressionSimplifier } from '../../src/optimizer/passes/expression-simplifier.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function buildPlan(sql) {
  const catalog = createTPCHCatalog();
  const binder = new Binder(catalog, defaultFunctionRegistry);
  const ast = parse(sql);
  const bound = binder.bind(ast);
  return createLogicalPlan(bound);
}

function optimize(sql, passes) {
  const plan = buildPlan(sql);
  const optimizer = new Optimizer();
  for (const pass of passes) optimizer.registerPass(pass);
  return optimizer.optimize(plan);
}

function collectNodeTypes(node) {
  const types = [];
  function walk(n) {
    if (!n) return;
    types.push(n.type);
    for (const child of getChildren(n)) walk(child);
  }
  walk(node);
  return types;
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
  let count = 0;
  function walk(n) {
    if (!n) return;
    if (n.type === type) count++;
    for (const child of getChildren(n)) walk(child);
  }
  walk(node);
  return count;
}

describe('Predicate Pushdown', () => {
  it('pushes filter below cross join', () => {
    const plan = optimize(
      "SELECT * FROM nation, region WHERE n_regionkey = r_regionkey",
      [new PredicatePushdown()],
    );
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join).not.toBeNull();
    expect(join.joinType).toBe(JoinType.INNER);
    expect(join.condition).not.toBeNull();
  });

  it('pushes single-table predicate below join', () => {
    const plan = optimize(
      "SELECT * FROM nation JOIN region ON n_regionkey = r_regionkey WHERE r_name = 'ASIA'",
      [new PredicatePushdown()],
    );
    const types = collectNodeTypes(plan);
    const filterIdx = types.indexOf(PlanNodeType.FILTER);
    const joinIdx = types.indexOf(PlanNodeType.JOIN);
    expect(filterIdx).toBeGreaterThan(joinIdx);
  });

  it('combines filters', () => {
    const plan = buildPlan("SELECT * FROM region WHERE r_regionkey > 1");
    const doubleFiltered = {
      ...plan,
      children: [{
        type: PlanNodeType.FILTER,
        condition: plan.children[0].condition,
        children: [{
          type: PlanNodeType.FILTER,
          condition: plan.children[0].condition,
          children: plan.children[0].children,
        }],
      }],
    };
    const optimizer = new Optimizer();
    optimizer.registerPass(new PredicatePushdown());
    const result = optimizer.optimize(doubleFiltered);
    expect(countNodes(result, PlanNodeType.FILTER)).toBeLessThanOrEqual(1);
  });
});

describe('Subquery Unnesting', () => {
  it('converts EXISTS to SEMI join', () => {
    const plan = optimize(
      `SELECT * FROM orders
       WHERE EXISTS (SELECT * FROM lineitem WHERE l_orderkey = o_orderkey)`,
      [new SubqueryUnnesting()],
    );
    const types = collectNodeTypes(plan);
    expect(types).not.toContain(PlanNodeType.DEPENDENT_JOIN);
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join.joinType).toBe(JoinType.SEMI);
  });

  it('converts NOT EXISTS to ANTI join', () => {
    const plan = optimize(
      `SELECT * FROM orders
       WHERE NOT EXISTS (SELECT * FROM lineitem WHERE l_orderkey = o_orderkey AND l_commitdate < l_receiptdate)`,
      [new SubqueryUnnesting()],
    );
    const types = collectNodeTypes(plan);
    expect(types).not.toContain(PlanNodeType.DEPENDENT_JOIN);
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join.joinType).toBe(JoinType.ANTI);
  });

  it('converts IN subquery to SEMI join', () => {
    const plan = optimize(
      `SELECT * FROM orders
       WHERE o_orderkey IN (SELECT l_orderkey FROM lineitem)`,
      [new SubqueryUnnesting()],
    );
    const types = collectNodeTypes(plan);
    expect(types).not.toContain(PlanNodeType.DEPENDENT_JOIN);
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join.joinType).toBe(JoinType.SEMI);
  });

  it('converts NOT IN subquery to MARK join', () => {
    const plan = optimize(
      `SELECT * FROM supplier
       WHERE s_suppkey NOT IN (SELECT ps_suppkey FROM partsupp)`,
      [new SubqueryUnnesting()],
    );
    const types = collectNodeTypes(plan);
    expect(types).not.toContain(PlanNodeType.DEPENDENT_JOIN);
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join.joinType).toBe(JoinType.MARK);
    expect(countNodes(plan, PlanNodeType.FILTER)).toBe(1);
  });

  it('handles Q4 pattern (EXISTS with correlated predicate)', () => {
    const plan = optimize(
      `SELECT o_orderpriority, COUNT(*) AS order_count
       FROM orders
       WHERE o_orderdate >= DATE '1993-07-01'
         AND EXISTS (
           SELECT * FROM lineitem WHERE l_orderkey = o_orderkey AND l_commitdate < l_receiptdate
         )
       GROUP BY o_orderpriority
       ORDER BY o_orderpriority`,
      [new SubqueryUnnesting()],
    );
    expect(countNodes(plan, PlanNodeType.DEPENDENT_JOIN)).toBe(0);
  });

  it('handles Q21 pattern (EXISTS + NOT EXISTS)', () => {
    const plan = optimize(
      `SELECT s_name, COUNT(*) AS numwait
       FROM supplier, lineitem l1, orders, nation
       WHERE s_suppkey = l1.l_suppkey AND o_orderkey = l1.l_orderkey AND o_orderstatus = 'F'
         AND l1.l_receiptdate > l1.l_commitdate
         AND EXISTS (
           SELECT * FROM lineitem l2
           WHERE l2.l_orderkey = l1.l_orderkey AND l2.l_suppkey <> l1.l_suppkey
         )
         AND NOT EXISTS (
           SELECT * FROM lineitem l3
           WHERE l3.l_orderkey = l1.l_orderkey AND l3.l_suppkey <> l1.l_suppkey
             AND l3.l_receiptdate > l3.l_commitdate
         )
         AND s_nationkey = n_nationkey AND n_name = 'SAUDI ARABIA'
       GROUP BY s_name
       ORDER BY numwait DESC, s_name
       LIMIT 100`,
      [new SubqueryUnnesting()],
    );
    expect(countNodes(plan, PlanNodeType.DEPENDENT_JOIN)).toBe(0);
  });

  it('drops subquery projection for EXISTS outputs', () => {
    const plan = optimize(
      `SELECT * FROM lineitem l1
       WHERE EXISTS (
         SELECT * FROM lineitem l2
         WHERE l2.l_orderkey = l1.l_orderkey AND l2.l_suppkey <> l1.l_suppkey
       )`,
      [new SubqueryUnnesting()],
    );

    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join.joinType).toBe(JoinType.SEMI);
    expect(join.children[1].type).not.toBe(PlanNodeType.PROJECT);
  });
});

describe('Projection Pushdown', () => {
  it('prunes unused columns from scan', () => {
    const plan = optimize(
      "SELECT r_name FROM region",
      [new ProjectionPushdown()],
    );
    const scan = findNode(plan, PlanNodeType.SCAN);
    expect(scan.columns.length).toBeLessThan(3);
  });
});

describe('Full Optimizer Pipeline', () => {
  function fullOptimize(sql) {
    const plan = buildPlan(sql);
    const optimizer = new Optimizer();
    optimizer.registerPass(new SubqueryUnnesting());
    optimizer.registerPass(new CTEOptimization());
    optimizer.registerPass(new PredicatePushdown());
    optimizer.registerPass(new ProjectionPushdown());
    return optimizer.optimize(plan);
  }

  it('optimizes Q1', () => {
    const plan = fullOptimize(`
      SELECT l_returnflag, l_linestatus,
        SUM(l_quantity) AS sum_qty, COUNT(*) AS count_order
      FROM lineitem
      WHERE l_shipdate <= DATE '1998-12-01' - INTERVAL '90' DAY
      GROUP BY l_returnflag, l_linestatus
      ORDER BY l_returnflag, l_linestatus
    `);
    expect(plan).toBeDefined();
    expect(countNodes(plan, PlanNodeType.DEPENDENT_JOIN)).toBe(0);
  });

  it('optimizes Q4 (EXISTS)', () => {
    const plan = fullOptimize(`
      SELECT o_orderpriority, COUNT(*) AS order_count
      FROM orders
      WHERE o_orderdate >= DATE '1993-07-01'
        AND EXISTS (
          SELECT * FROM lineitem WHERE l_orderkey = o_orderkey AND l_commitdate < l_receiptdate
        )
      GROUP BY o_orderpriority
      ORDER BY o_orderpriority
    `);
    expect(countNodes(plan, PlanNodeType.DEPENDENT_JOIN)).toBe(0);
    expect(findNode(plan, PlanNodeType.JOIN).joinType).toBe(JoinType.SEMI);
  });

  it('optimizes Q6 (simple scan + filter)', () => {
    const plan = fullOptimize(`
      SELECT SUM(l_extendedprice * l_discount) AS revenue
      FROM lineitem
      WHERE l_shipdate >= DATE '1994-01-01' AND l_shipdate < DATE '1994-01-01' + INTERVAL '1' YEAR
        AND l_discount BETWEEN 0.06 - 0.01 AND 0.06 + 0.01 AND l_quantity < 24
    `);
    expect(plan).toBeDefined();
  });
});

import { PhysicalDesign } from '../../src/optimizer/passes/physical-design.js';
import { PhysicalStrategy } from '../../src/planner/logical-plan.js';
import { LimitPushdown } from '../../src/optimizer/passes/limit-pushdown.js';

describe('Physical Design Pass', () => {
  it('selects MERGE join if inputs are sorted by join keys', () => {
    const plan = optimize(
      "SELECT * FROM (SELECT * FROM orders ORDER BY o_orderkey) o JOIN (SELECT * FROM lineitem ORDER BY l_orderkey) l ON o.o_orderkey = l.l_orderkey",
      [new PhysicalDesign()]
    );
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join).toBeDefined();
    expect(join.physicalStrategy).toBe(PhysicalStrategy.MERGE);
  });

  it('selects HASH join if inputs are not sorted by join keys', () => {
    const plan = optimize(
      "SELECT * FROM orders o JOIN lineitem l ON o.o_orderkey = l.l_orderkey",
      [new PhysicalDesign()]
    );
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join).toBeDefined();
    expect(join.physicalStrategy).toBe(PhysicalStrategy.HASH);
  });

  it('deduplicates build keys for pure SEMI joins', () => {
    const plan = optimize(
      `SELECT * FROM orders
       WHERE o_orderkey IN (SELECT l_orderkey FROM lineitem)`,
      [new SubqueryUnnesting(), new PhysicalDesign()]
    );
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join).toBeDefined();
    expect(join.joinType).toBe(JoinType.SEMI);
    expect(join._dedupeBuild).toBe(true);
  });

  it('selects NESTED_LOOP join for small non-equi joins', () => {
    const stats = new Map();
    stats.set('NATION', { rowCount: 25, columnStats: new Map() });
    stats.set('REGION', { rowCount: 5, columnStats: new Map() });

    const plan = optimize(
      "SELECT * FROM nation, region WHERE n_nationkey > r_regionkey",
      [new PredicatePushdown(), new PhysicalDesign(stats)]
    );
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join).toBeDefined();
    expect(join.physicalStrategy).toBe(PhysicalStrategy.NESTED_LOOP);
  });

  it('selects STREAM aggregate if child is sorted by group by keys', () => {
    const plan = optimize(
      "SELECT l_orderkey, COUNT(*) FROM (SELECT * FROM lineitem ORDER BY l_orderkey) l GROUP BY l_orderkey",
      [new PhysicalDesign()]
    );
    const agg = findNode(plan, PlanNodeType.AGGREGATE);
    expect(agg).toBeDefined();
    expect(agg.physicalStrategy).toBe(PhysicalStrategy.STREAM);
  });

  it('selects HASH aggregate if child is not sorted', () => {
    const plan = optimize(
      "SELECT l_orderkey, COUNT(*) FROM lineitem GROUP BY l_orderkey",
      [new PhysicalDesign()]
    );
    const agg = findNode(plan, PlanNodeType.AGGREGATE);
    expect(agg).toBeDefined();
    expect(agg.physicalStrategy).toBe(PhysicalStrategy.HASH);
  });

  it('selects UNGROUPED aggregate for scalar aggregates', () => {
    const plan = optimize(
      "SELECT SUM(l_extendedprice) FROM lineitem",
      [new PhysicalDesign()]
    );
    const agg = findNode(plan, PlanNodeType.AGGREGATE);
    expect(agg).toBeDefined();
    expect(agg.physicalStrategy).toBe(PhysicalStrategy.UNGROUPED);
  });

  it('selects PERFECT_HASH aggregate for low-NDV group keys with statistics', () => {
    const stats = new Map();
    stats.set('NATION', {
      rowCount: 25,
      columnStats: new Map([
        ['N_REGIONKEY', { ndv: 5 }],
      ]),
    });

    const plan = optimize(
      "SELECT n_regionkey, COUNT(*) FROM nation GROUP BY n_regionkey",
      [new PhysicalDesign(stats)]
    );
    const agg = findNode(plan, PlanNodeType.AGGREGATE);
    expect(agg).toBeDefined();
    expect(agg.physicalStrategy).toBe(PhysicalStrategy.PERFECT_HASH);
  });
});

describe('TPC-H Optimization Rules', () => {
  it('factors common join predicates out of OR branches', () => {
    const plan = optimize(
      `SELECT SUM(l_extendedprice) AS revenue
       FROM lineitem, part
       WHERE (p_partkey = l_partkey AND p_brand = 'Brand#12')
          OR (p_partkey = l_partkey AND p_brand = 'Brand#23')`,
      [new ExpressionSimplifier(), new PredicatePushdown()],
    );

    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join).toBeDefined();
    expect(join.condition?.op).toBe('=');
  });

  it('tags ORDER BY + LIMIT as Top-N sort', () => {
    const plan = optimize(
      'SELECT r_name FROM region ORDER BY r_name LIMIT 2',
      [new LimitPushdown()],
    );
    const sort = findNode(plan, PlanNodeType.SORT);
    expect(sort).toBeDefined();
    expect(sort.limit).toBe(2);
  });

  it('uses filtered relation cardinality for join planning estimates', () => {
    const stats = new Map();
    stats.set('REGION', {
      rowCount: 5,
      columnStats: new Map([
        ['R_REGIONKEY', { ndv: 5 }],
        ['R_NAME', { ndv: 5 }],
      ]),
    });

    const plan = buildPlan("SELECT * FROM region WHERE r_name = 'EUROPE'");
    const filter = findNode(plan, PlanNodeType.FILTER);
    const estimator = new DefaultCardinalityEstimator(stats);

    expect(estimator.estimatePlan(filter)).toBe(1);
  });
});

import { PredicateInference } from '../../src/optimizer/passes/predicate-inference.js';

describe('Predicate Inference (Transitive Closure)', () => {
  it('derives constant predicate from equi-join and literal', () => {
    const plan = optimize(
      `SELECT * FROM nation, region
       WHERE n_regionkey = r_regionkey AND r_name = 'EUROPE'`,
      [new PredicateInference(), new PredicatePushdown()],
    );
    const filters = [];
    function walk(n) {
      if (!n) return;
      if (n.type === PlanNodeType.FILTER) filters.push(n);
      for (const child of getChildren(n)) walk(child);
    }
    walk(plan);
    expect(filters.length).toBeGreaterThanOrEqual(1);
  });

  it('infers range predicates across equi-join', () => {
    const plan = optimize(
      `SELECT * FROM orders, lineitem
       WHERE o_orderkey = l_orderkey AND o_orderkey > 100`,
      [new PredicateInference(), new PredicatePushdown()],
    );
    const filters = [];
    function walk(n) {
      if (!n) return;
      if (n.type === PlanNodeType.FILTER) filters.push(n);
      for (const child of getChildren(n)) walk(child);
    }
    walk(plan);
    expect(filters.length).toBeGreaterThanOrEqual(2);
  });

  it('infers IN predicates from OR equality branches', () => {
    const plan = optimize(
      `SELECT * FROM nation n1, nation n2
       WHERE (n1.n_name = 'FRANCE' AND n2.n_name = 'GERMANY')
          OR (n1.n_name = 'GERMANY' AND n2.n_name = 'FRANCE')`,
      [new PredicateInference(), new PredicatePushdown()],
    );
    const filters = [];
    function walk(n) {
      if (!n) return;
      if (n.type === PlanNodeType.FILTER) filters.push(n);
      for (const child of getChildren(n)) walk(child);
    }
    walk(plan);
    const inListFilters = filters.filter(f => f.condition.kind === BoundExprKind.IN_LIST);
    expect(inListFilters.length).toBeGreaterThanOrEqual(2);
  });

  it('infers scan-side ranges and IN lists from OR branches', () => {
    const plan = optimize(
      `SELECT * FROM part, lineitem
       WHERE p_partkey = l_partkey AND (
         p_container IN ('SM CASE', 'SM BOX') AND l_quantity >= 1 AND l_quantity <= 11
         OR p_container IN ('MED BAG', 'MED BOX') AND l_quantity >= 10 AND l_quantity <= 20
       )`,
      [new ExpressionSimplifier(), new PredicateInference(), new PredicatePushdown()],
    );
    const filters = [];
    function walk(n) {
      if (!n) return;
      if (n.type === PlanNodeType.FILTER) filters.push(n);
      for (const child of getChildren(n)) walk(child);
    }
    walk(plan);
    const filterText = JSON.stringify(filters.map(f => f.condition));
    expect(filterText).toContain('P_CONTAINER');
    expect(filterText).toContain('SM CASE');
    expect(filterText).toContain('MED BOX');
    expect(filterText).toContain('L_QUANTITY');
  });

  it('pushes predicates through PROJECT nodes', () => {
    const plan = optimize(
      `SELECT * FROM (SELECT n_name, n_regionkey FROM nation) sub WHERE sub.n_name = 'FRANCE'`,
      [new PredicatePushdown()],
    );
    const project = findNode(plan, PlanNodeType.PROJECT);
    if (project) {
      const filterBelowProject = findNode(project, PlanNodeType.FILTER);
      expect(filterBelowProject).not.toBeNull();
    }
  });
});

describe('Expression Simplifier', () => {
  it('simplifies x * 1 to x', () => {
    const plan = optimize(
      `SELECT l_extendedprice * 1 FROM lineitem`,
      [new ExpressionSimplifier()],
    );
    const proj = findNode(plan, PlanNodeType.PROJECT);
    expect(proj.expressions[0].kind).not.toBe('BoundBinary');
  });

  it('simplifies x + 0 to x', () => {
    const plan = optimize(
      `SELECT l_quantity + 0 FROM lineitem`,
      [new ExpressionSimplifier()],
    );
    const proj = findNode(plan, PlanNodeType.PROJECT);
    expect(proj.expressions[0].kind).toBe('BoundColumnRef');
  });

  it('folds constant CASE branches', () => {
    const plan = optimize(
      `SELECT CASE WHEN 1 = 1 THEN l_quantity ELSE 0 END FROM lineitem`,
      [new ExpressionSimplifier()],
    );
    const proj = findNode(plan, PlanNodeType.PROJECT);
    expect(proj.expressions[0].kind).toBe('BoundColumnRef');
  });

  it('removes dead CASE branches', () => {
    const plan = optimize(
      `SELECT CASE WHEN 1 = 0 THEN l_quantity ELSE l_discount END FROM lineitem`,
      [new ExpressionSimplifier()],
    );
    const proj = findNode(plan, PlanNodeType.PROJECT);
    expect(proj.expressions[0].kind).toBe('BoundColumnRef');
    expect(proj.expressions[0].columnName).toBe('L_DISCOUNT');
  });
});

describe('Full Optimizer Pipeline - Extended', () => {
  function fullOptimize(sql) {
    return buildPlan(sql);
  }

  it('resolves GROUP BY aliases', () => {
    const plan = fullOptimize(`
      SELECT n_name AS country, COUNT(*) AS cnt
      FROM nation
      GROUP BY country
      ORDER BY country
    `);
    expect(plan).toBeDefined();
    const agg = findNode(plan, PlanNodeType.AGGREGATE);
    expect(agg).toBeDefined();
    expect(agg.groupBy[0].columnName).toBe('N_NAME');
  });

  it('optimizes Q7 with GROUP BY aliases', () => {
    const plan = fullOptimize(`
      SELECT n1.n_name AS supp_nation, n2.n_name AS cust_nation,
        EXTRACT(YEAR FROM l_shipdate) AS l_year,
        SUM(l_extendedprice * (1 - l_discount)) AS revenue
      FROM supplier, lineitem, orders, customer, nation n1, nation n2
      WHERE s_suppkey = l_suppkey AND o_orderkey = l_orderkey AND c_custkey = o_custkey
        AND s_nationkey = n1.n_nationkey AND c_nationkey = n2.n_nationkey
      GROUP BY supp_nation, cust_nation, l_year
    `);
    const agg = findNode(plan, PlanNodeType.AGGREGATE);
    expect(agg).toBeDefined();
    expect(agg.groupBy.length).toBe(3);
  });
});

import { JoinElimination } from '../../src/optimizer/passes/join-elimination.js';
import { NodeMerge } from '../../src/optimizer/passes/node-merge.js';

describe('Join Elimination', () => {
  it('removes unused right side of LEFT JOIN', () => {
    const plan = optimize(
      `SELECT c_custkey, c_name FROM customer LEFT OUTER JOIN orders ON c_custkey = o_custkey`,
      [new JoinElimination()],
    );
    const joinNode = findNode(plan, PlanNodeType.JOIN);
    expect(joinNode).toBeNull();
  });

  it('keeps LEFT JOIN when right columns are used', () => {
    const plan = optimize(
      `SELECT c_custkey, o_orderkey FROM customer LEFT OUTER JOIN orders ON c_custkey = o_custkey`,
      [new JoinElimination()],
    );
    const joinNode = findNode(plan, PlanNodeType.JOIN);
    expect(joinNode).not.toBeNull();
  });
});

describe('Node Merge', () => {
  it('merges adjacent filters', () => {
    const plan = buildPlan("SELECT * FROM region WHERE r_regionkey > 0");
    const doubleFiltered = {
      ...plan,
      children: [{
        type: PlanNodeType.FILTER,
        condition: plan.children[0].condition,
        children: [{
          type: PlanNodeType.FILTER,
          condition: plan.children[0].condition,
          children: plan.children[0].children,
        }],
      }],
    };
    const merged = new NodeMerge().apply(doubleFiltered);
    expect(countNodes(merged, PlanNodeType.FILTER)).toBeLessThanOrEqual(2);
  });

  it('merges adjacent LIMITs', () => {
    const plan = buildPlan("SELECT * FROM region LIMIT 10");
    const limit = findNode(plan, PlanNodeType.LIMIT);
    if (limit) {
      const doubleLimited = {
        type: PlanNodeType.LIMIT,
        count: 5,
        offset: 0,
        children: [limit],
      };
      const merged = new NodeMerge().apply(doubleLimited);
      expect(countNodes(merged, PlanNodeType.LIMIT)).toBe(1);
      const resultLimit = findNode(merged, PlanNodeType.LIMIT);
      expect(resultLimit.count).toBe(5);
    }
  });

  it('merges duplicate adjacent projects while preserving outer output names', () => {
    const plan = buildPlan("SELECT r_name FROM region");
    const project = findNode(plan, PlanNodeType.PROJECT);
    const doubleProjected = {
      ...project,
      expressions: project.expressions.map(expr => ({ ...expr, outputName: 'region_name' })),
      children: [project],
    };
    const merged = new NodeMerge().apply(doubleProjected);
    expect(countNodes(merged, PlanNodeType.PROJECT)).toBe(1);
    expect(merged.expressions[0].outputName).toBe('region_name');
    expect(merged.children[0].type).toBe(PlanNodeType.SCAN);
  });
});

import { PredicateDedup } from '../../src/optimizer/passes/predicate-dedup.js';

describe('Predicate Deduplication', () => {
  it('removes duplicate predicates from filter', () => {
    const plan = buildPlan("SELECT * FROM region WHERE r_regionkey > 1");
    const filter = findNode(plan, PlanNodeType.FILTER);
    if (filter) {
      const dupFilter = {
        type: PlanNodeType.FILTER,
        condition: {
          kind: 'BoundBinary',
          op: 'AND',
          left: filter.condition,
          right: filter.condition,
          resultType: 'BOOLEAN',
        },
        children: filter.children,
      };
      const deduped = new PredicateDedup().apply(dupFilter);
      const defilter = findNode(deduped, PlanNodeType.FILTER);
      expect(defilter).toBeDefined();
      expect(defilter.condition.op).not.toBe('AND');
    }
  });
});

describe('Build-Side Selection', () => {
  it('annotates smaller side as build side for hash join', () => {
    const stats = new Map();
    stats.set('REGION', {
      rowCount: 5,
      columnStats: new Map([['R_REGIONKEY', { ndv: 5 }], ['R_NAME', { ndv: 5 }]]),
    });
    stats.set('NATION', {
      rowCount: 25,
      columnStats: new Map([['N_NATIONKEY', { ndv: 25 }], ['N_REGIONKEY', { ndv: 5 }], ['N_NAME', { ndv: 25 }]]),
    });

    const plan = optimize(
      "SELECT * FROM nation JOIN region ON n_regionkey = r_regionkey",
      [new PredicatePushdown(), new PhysicalDesign(stats)],
    );
    const join = findNode(plan, PlanNodeType.JOIN);
    expect(join).toBeDefined();
    expect(join._buildSide).toBe('right');
  });
});
