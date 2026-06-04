import { describe, it, expect } from 'vitest';
import { HyperGraph, buildHyperGraph, popcount, subsets } from '../../src/optimizer/dphyp/hypergraph.js';
import { runDPhyp, DPhypEnumerator } from '../../src/optimizer/dphyp/dphyp.js';
import { DefaultCostModel } from '../../src/optimizer/dphyp/cost-model.js';
import { DefaultCardinalityEstimator } from '../../src/optimizer/dphyp/cardinality.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { parse } from '../../src/parser/parser.js';
import { Binder } from '../../src/binder/binder.js';
import { createTPCHCatalog } from '../../src/catalog/tpch-schema.js';
import { defaultFunctionRegistry } from '../../src/catalog/function-registry.js';
import { createLogicalPlan } from '../../src/planner/logical-planner.js';
import { Optimizer } from '../../src/optimizer/optimizer.js';
import { SubqueryUnnesting } from '../../src/optimizer/passes/subquery-unnesting.js';
import { PredicatePushdown } from '../../src/optimizer/passes/predicate-pushdown.js';
import { JoinReorder } from '../../src/optimizer/passes/join-reorder.js';
import { PlanNodeType, JoinType, getChildren } from '../../src/planner/logical-plan.js';

function makeColRef(table, col) {
  return {
    kind: BoundExprKind.COLUMN_REF,
    tableAlias: table,
    columnName: col,
    columnIndex: 0,
    dataType: 'INT32',
    depth: 0,
    isCorrelated: false,
  };
}

function makeEqPred(t1, c1, t2, c2) {
  return {
    kind: BoundExprKind.BINARY,
    op: '=',
    left: makeColRef(t1, c1),
    right: makeColRef(t2, c2),
    resultType: 'BOOLEAN',
  };
}

describe('HyperGraph', () => {
  it('constructs graph with relations and edges', () => {
    const g = new HyperGraph();
    g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
    g.addRelation('B', { type: 'Scan', table: 'B' }, 200);
    g.addRelation('C', { type: 'Scan', table: 'C' }, 300);

    g.addEdge(['A'], ['B'], makeEqPred('A', 'id', 'B', 'aid'));
    g.addEdge(['B'], ['C'], makeEqPred('B', 'id', 'C', 'bid'));

    expect(g.size).toBe(3);
    expect(g.fullMask).toBe(7);
    expect(g.getNeighborhood(0b001)).toBe(0b010);
    expect(g.getNeighborhood(0b010)).toBe(0b101);
  });

  it('checks connectivity', () => {
    const g = new HyperGraph();
    g.addRelation('A', null, 10);
    g.addRelation('B', null, 20);
    g.addRelation('C', null, 30);
    g.addEdge(['A'], ['B'], makeEqPred('A', 'x', 'B', 'y'));
    g.addEdge(['B'], ['C'], makeEqPred('B', 'x', 'C', 'y'));

    expect(g.isConnected(0b111)).toBe(true);
    expect(g.isConnected(0b011)).toBe(true);
    expect(g.isConnected(0b101)).toBe(false);
    expect(g.isConnected(0b001)).toBe(true);
  });

  it('finds join predicates', () => {
    const g = new HyperGraph();
    g.addRelation('A', null, 10);
    g.addRelation('B', null, 20);
    const pred = makeEqPred('A', 'x', 'B', 'y');
    g.addEdge(['A'], ['B'], pred);

    const preds = g.findJoinPredicates(0b01, 0b10);
    expect(preds.length).toBeGreaterThan(0);
  });
});

describe('Utility functions', () => {
  it('popcount works', () => {
    expect(popcount(0)).toBe(0);
    expect(popcount(1)).toBe(1);
    expect(popcount(7)).toBe(3);
    expect(popcount(0b10101)).toBe(3);
  });

  it('subsets enumerates all subsets', () => {
    const s = subsets(0b111);
    expect(s).toContain(0b111);
    expect(s).toContain(0b110);
    expect(s).toContain(0b001);
    expect(s.length).toBe(7);
  });
});

describe('DefaultCostModel', () => {
  const model = new DefaultCostModel();

  it('computes hash join cost', () => {
    const cost = model.hashJoinCost(100, 1000);
    expect(cost).toBeGreaterThan(0);
    const expected = 100 * 1.5 + 1000 * 1.0 + 100 * 0.05 + 1000 * 0.3;
    expect(cost).toBeCloseTo(expected, 1);
  });

  it('computes sort cost', () => {
    expect(model.sortCost(1000)).toBeGreaterThan(0);
    expect(model.sortCost(1)).toBe(0);
  });

  it('top-N sort is cheaper than full sort', () => {
    const fullCost = model.sortCost(10000);
    const topNCost = model.topNSortCost(10000, 10);
    expect(topNCost).toBeLessThan(fullCost);
  });

  it('smaller build side has lower hash join cost', () => {
    const small = model.hashJoinCost(100, 10000);
    const big = model.hashJoinCost(10000, 100);
    expect(small).toBeLessThan(big);
  });

  it('cross join has extremely high cost', () => {
    const hashCost = model.hashJoinCost(1000, 1000);
    const crossCost = model.crossJoinCost(1000, 1000);
    expect(crossCost).toBeGreaterThan(hashCost * 10);
  });
});

describe('DefaultCardinalityEstimator', () => {
  const stats = new Map();
  stats.set('LINEITEM', {
    rowCount: 60000,
    columnStats: new Map([
      ['L_ORDERKEY', { ndv: 15000 }],
      ['L_SUPPKEY', { ndv: 100 }],
    ]),
  });
  stats.set('ORDERS', {
    rowCount: 15000,
    columnStats: new Map([
      ['O_ORDERKEY', { ndv: 15000 }],
      ['O_CUSTKEY', { ndv: 1500 }],
    ]),
  });

  const est = new DefaultCardinalityEstimator(stats);

  it('estimates scan cardinality', () => {
    expect(est.estimateScan('LINEITEM')).toBe(60000);
    expect(est.estimateScan('ORDERS')).toBe(15000);
    expect(est.estimateScan('UNKNOWN')).toBe(1000);
  });

  it('estimates join cardinality', () => {
    const pred = makeEqPred('LINEITEM', 'L_ORDERKEY', 'ORDERS', 'O_ORDERKEY');
    const card = est.estimateJoin(60000, 15000, pred);
    expect(card).toBe(60000);
  });

  it('estimates filter selectivity', () => {
    const eqPred = {
      kind: BoundExprKind.BINARY,
      op: '=',
      left: makeColRef('LINEITEM', 'L_SUPPKEY'),
      right: { kind: BoundExprKind.LITERAL, value: 5, dataType: 'INT32' },
      resultType: 'BOOLEAN',
    };
    const sel = est.estimateSelectivity(eqPred);
    expect(sel).toBeCloseTo(0.01, 1);
  });

  it('SEMI join produces at most |left| rows', () => {
    const pred = makeEqPred('LINEITEM', 'L_ORDERKEY', 'ORDERS', 'O_ORDERKEY');
    const card = est.estimateSemiJoin(60000, 15000, pred);
    expect(card).toBeLessThanOrEqual(60000);
    expect(card).toBeGreaterThan(0);
  });

  it('ANTI join is complement of SEMI join', () => {
    const pred = makeEqPred('LINEITEM', 'L_ORDERKEY', 'ORDERS', 'O_ORDERKEY');
    const semiCard = est.estimateSemiJoin(60000, 15000, pred);
    const antiCard = est.estimateAntiJoin(60000, 15000, pred);
    expect(semiCard + antiCard).toBeLessThanOrEqual(60001);
    expect(antiCard).toBeGreaterThan(0);
  });

  it('LEFT join produces at least |left| rows', () => {
    const pred = makeEqPred('LINEITEM', 'L_ORDERKEY', 'ORDERS', 'O_ORDERKEY');
    const card = est.estimateLeftJoin(60000, 15000, pred);
    expect(card).toBeGreaterThanOrEqual(60000);
  });

  it('MARK join preserves left cardinality', () => {
    const pred = makeEqPred('LINEITEM', 'L_ORDERKEY', 'ORDERS', 'O_ORDERKEY');
    const plan = {
      type: PlanNodeType.JOIN,
      joinType: JoinType.MARK,
      condition: pred,
      children: [
        { type: PlanNodeType.SCAN, table: 'LINEITEM' },
        { type: PlanNodeType.SCAN, table: 'ORDERS' },
      ],
    };
    expect(est.estimatePlan(plan)).toBe(60000);
  });

  it('col = col selectivity uses max(NDV)', () => {
    const pred = {
      kind: BoundExprKind.BINARY, op: '=',
      left: makeColRef('LINEITEM', 'L_SUPPKEY'),
      right: makeColRef('ORDERS', 'O_CUSTKEY'),
      resultType: 'BOOLEAN',
    };
    const sel = est.estimateSelectivity(pred);
    expect(sel).toBeCloseTo(1 / 1500, 3);
  });

  it('<> selectivity is complement of =', () => {
    const pred = {
      kind: BoundExprKind.BINARY, op: '<>',
      left: makeColRef('LINEITEM', 'L_SUPPKEY'),
      right: { kind: BoundExprKind.LITERAL, value: 5, dataType: 'INT32' },
      resultType: 'BOOLEAN',
    };
    const sel = est.estimateSelectivity(pred);
    expect(sel).toBeGreaterThan(0.98);
  });

  it('AND selectivity with correlation cap', () => {
    const pred1 = {
      kind: BoundExprKind.BINARY, op: '=',
      left: makeColRef('LINEITEM', 'L_SUPPKEY'),
      right: { kind: BoundExprKind.LITERAL, value: 5, dataType: 'INT32' },
      resultType: 'BOOLEAN',
    };
    const andPred = {
      kind: BoundExprKind.BINARY, op: 'AND',
      left: pred1, right: pred1,
      resultType: 'BOOLEAN',
    };
    const singleSel = est.estimateSelectivity(pred1);
    const andSel = est.estimateSelectivity(andPred);
    expect(andSel).toBeGreaterThan(singleSel * singleSel * 0.9);
    expect(andSel).toBeLessThanOrEqual(singleSel);
  });

  it('aggregate with correlation cap on group-by NDVs', () => {
    const groupBy = [
      makeColRef('LINEITEM', 'L_ORDERKEY'),
      makeColRef('LINEITEM', 'L_SUPPKEY'),
    ];
    const card = est.estimateAggregate(60000, 2, groupBy);
    expect(card).toBeLessThanOrEqual(60000);
    expect(card).toBeGreaterThan(15000);
  });
});

describe('DPhyp', () => {
  it('finds optimal join order for chain A-B-C', () => {
    const stats = new Map();
    stats.set('A', { rowCount: 100, columnStats: new Map([['ID', { ndv: 100 }]]) });
    stats.set('B', { rowCount: 10000, columnStats: new Map([['AID', { ndv: 100 }], ['ID', { ndv: 10000 }]]) });
    stats.set('C', { rowCount: 50, columnStats: new Map([['BID', { ndv: 50 }]]) });

    const costModel = new DefaultCostModel();
    const cardEst = new DefaultCardinalityEstimator(stats);

    const g = new HyperGraph();
    g.addRelation('A', { type: 'Scan', table: 'A' }, 100);
    g.addRelation('B', { type: 'Scan', table: 'B' }, 10000);
    g.addRelation('C', { type: 'Scan', table: 'C' }, 50);

    g.addEdge(['A'], ['B'], makeEqPred('A', 'ID', 'B', 'AID'));
    g.addEdge(['B'], ['C'], makeEqPred('B', 'ID', 'C', 'BID'));

    const result = runDPhyp(g, costModel, cardEst);
    expect(result).not.toBeNull();
    expect(result.plan.type).toBe('HashJoin');
    expect(result.totalCost).toBeGreaterThan(0);
  });

  it('finds optimal join order for star schema', () => {
    const stats = new Map();
    stats.set('FACT', { rowCount: 100000, columnStats: new Map([
      ['D1_ID', { ndv: 100 }], ['D2_ID', { ndv: 200 }], ['D3_ID', { ndv: 50 }],
    ])});
    stats.set('D1', { rowCount: 100, columnStats: new Map([['ID', { ndv: 100 }]]) });
    stats.set('D2', { rowCount: 200, columnStats: new Map([['ID', { ndv: 200 }]]) });
    stats.set('D3', { rowCount: 50, columnStats: new Map([['ID', { ndv: 50 }]]) });

    const costModel = new DefaultCostModel();
    const cardEst = new DefaultCardinalityEstimator(stats);

    const g = new HyperGraph();
    g.addRelation('FACT', { type: 'Scan', table: 'FACT' }, 100000);
    g.addRelation('D1', { type: 'Scan', table: 'D1' }, 100);
    g.addRelation('D2', { type: 'Scan', table: 'D2' }, 200);
    g.addRelation('D3', { type: 'Scan', table: 'D3' }, 50);

    g.addEdge(['FACT'], ['D1'], makeEqPred('FACT', 'D1_ID', 'D1', 'ID'));
    g.addEdge(['FACT'], ['D2'], makeEqPred('FACT', 'D2_ID', 'D2', 'ID'));
    g.addEdge(['FACT'], ['D3'], makeEqPred('FACT', 'D3_ID', 'D3', 'ID'));

    const result = runDPhyp(g, costModel, cardEst);
    expect(result).not.toBeNull();
    expect(result.cardinality).toBeGreaterThan(0);
  });

  it('produces lower cost than left-deep for chain', () => {
    const stats = new Map();
    stats.set('R1', { rowCount: 1000, columnStats: new Map([['K', { ndv: 1000 }]]) });
    stats.set('R2', { rowCount: 10, columnStats: new Map([['K', { ndv: 10 }], ['FK', { ndv: 10 }]]) });
    stats.set('R3', { rowCount: 5000, columnStats: new Map([['K', { ndv: 5000 }], ['FK', { ndv: 10 }]]) });

    const costModel = new DefaultCostModel();
    const cardEst = new DefaultCardinalityEstimator(stats);

    const g = new HyperGraph();
    g.addRelation('R1', { type: 'Scan', table: 'R1' }, 1000);
    g.addRelation('R2', { type: 'Scan', table: 'R2' }, 10);
    g.addRelation('R3', { type: 'Scan', table: 'R3' }, 5000);

    g.addEdge(['R1'], ['R2'], makeEqPred('R1', 'K', 'R2', 'K'));
    g.addEdge(['R2'], ['R3'], makeEqPred('R2', 'FK', 'R3', 'FK'));

    const result = runDPhyp(g, costModel, cardEst);
    expect(result).not.toBeNull();

    const leftDeepCost =
      costModel.scanCost(1000)
      + costModel.scanCost(10)
      + costModel.hashJoinCost(1000, 10)
      + costModel.scanCost(5000)
      + costModel.hashJoinCost(10, 5000);

    expect(result.totalCost).toBeLessThanOrEqual(leftDeepCost * 1.01);
  });
});

describe('JoinReorder Pass', () => {
  function buildPlan(sql) {
    const catalog = createTPCHCatalog();
    const binder = new Binder(catalog, defaultFunctionRegistry);
    const ast = parse(sql);
    const bound = binder.bind(ast);
    return createLogicalPlan(bound);
  }

  function countJoins(node) {
    let count = 0;
    function walk(n) {
      if (!n) return;
      if (n.type === PlanNodeType.JOIN) count++;
      for (const c of getChildren(n)) walk(c);
    }
    walk(node);
    return count;
  }

  it('reorders 3-table join', () => {
    const plan = buildPlan(`
      SELECT * FROM customer, orders, lineitem
      WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey
    `);

    const stats = new Map();
    stats.set('CUSTOMER', { rowCount: 1500, columnStats: new Map([['C_CUSTKEY', { ndv: 1500 }]]) });
    stats.set('ORDERS', { rowCount: 15000, columnStats: new Map([['O_CUSTKEY', { ndv: 1500 }], ['O_ORDERKEY', { ndv: 15000 }]]) });
    stats.set('LINEITEM', { rowCount: 60000, columnStats: new Map([['L_ORDERKEY', { ndv: 15000 }]]) });

    const optimizer = new Optimizer();
    optimizer.registerPass(new PredicatePushdown());
    optimizer.registerPass(new JoinReorder(stats));

    const optimized = optimizer.optimize(plan);
    expect(optimized).toBeDefined();
    expect(countJoins(optimized)).toBe(2);
  });

  it('reorders Q5 style 6-table join', () => {
    const plan = buildPlan(`
      SELECT n_name, SUM(l_extendedprice * (1 - l_discount)) AS revenue
      FROM customer, orders, lineitem, supplier, nation, region
      WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey AND l_suppkey = s_suppkey
        AND c_nationkey = s_nationkey AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey
        AND r_name = 'ASIA'
      GROUP BY n_name
      ORDER BY revenue DESC
    `);

    const stats = new Map();
    stats.set('CUSTOMER', { rowCount: 1500, columnStats: new Map([['C_CUSTKEY', { ndv: 1500 }], ['C_NATIONKEY', { ndv: 25 }]]) });
    stats.set('ORDERS', { rowCount: 15000, columnStats: new Map([['O_CUSTKEY', { ndv: 1500 }], ['O_ORDERKEY', { ndv: 15000 }]]) });
    stats.set('LINEITEM', { rowCount: 60000, columnStats: new Map([['L_ORDERKEY', { ndv: 15000 }], ['L_SUPPKEY', { ndv: 100 }]]) });
    stats.set('SUPPLIER', { rowCount: 100, columnStats: new Map([['S_SUPPKEY', { ndv: 100 }], ['S_NATIONKEY', { ndv: 25 }]]) });
    stats.set('NATION', { rowCount: 25, columnStats: new Map([['N_NATIONKEY', { ndv: 25 }], ['N_REGIONKEY', { ndv: 5 }]]) });
    stats.set('REGION', { rowCount: 5, columnStats: new Map([['R_REGIONKEY', { ndv: 5 }]]) });

    const optimizer = new Optimizer();
    optimizer.registerPass(new PredicatePushdown());
    optimizer.registerPass(new JoinReorder(stats));

    const optimized = optimizer.optimize(plan);
    expect(optimized).toBeDefined();
    expect(countJoins(optimized)).toBe(5);
  });
});
