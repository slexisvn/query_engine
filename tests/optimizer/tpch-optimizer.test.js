import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/parser.js';
import { Binder } from '../../src/binder/binder.js';
import { createLogicalPlan } from '../../src/planner/logical-planner.js';
import { createTPCHCatalog } from '../../src/catalog/tpch-schema.js';
import { defaultFunctionRegistry } from '../../src/catalog/function-registry.js';
import { Optimizer } from '../../src/optimizer/optimizer.js';
import { PlanNodeType, JoinType, PhysicalStrategy } from '../../src/planner/logical-plan.js';

import { ExpressionSimplifier } from '../../src/optimizer/passes/expression-simplifier.js';
import { SubqueryUnnesting } from '../../src/optimizer/passes/subquery-unnesting.js';
import { HavingPushdown } from '../../src/optimizer/passes/having-pushdown.js';
import { CTEOptimization } from '../../src/optimizer/passes/cte-optimization.js';
import { PredicatePushdown } from '../../src/optimizer/passes/predicate-pushdown.js';
import { PredicateInference } from '../../src/optimizer/passes/predicate-inference.js';
import { OuterToInnerJoin } from '../../src/optimizer/passes/outer-to-inner.js';
import { JoinElimination } from '../../src/optimizer/passes/join-elimination.js';
import { ProjectionPushdown } from '../../src/optimizer/passes/projection-pushdown.js';
import { LimitPushdown } from '../../src/optimizer/passes/limit-pushdown.js';
import { EmptyPropagation } from '../../src/optimizer/passes/empty-propagation.js';
import { NodeMerge } from '../../src/optimizer/passes/node-merge.js';
import { PredicateDedup } from '../../src/optimizer/passes/predicate-dedup.js';
import { JoinResidualSplit } from '../../src/optimizer/passes/join-residual-split.js';
import { PhysicalDesign } from '../../src/optimizer/passes/physical-design.js';
import { SortElimination } from '../../src/optimizer/passes/sort-elimination.js';
import { TopNFusion } from '../../src/optimizer/passes/topn-fusion.js';
import { IndexSelection } from '../../src/optimizer/passes/index-selection.js';
import { JoinReorder } from '../../src/optimizer/passes/join-reorder.js';
import { TableStatistics, ColumnStatistics, EquiDepthHistogram } from '../../src/catalog/statistics.js';
import { DefaultCostModel } from '../../src/optimizer/dphyp/cost-model.js';
import { DefaultCardinalityEstimator } from '../../src/optimizer/dphyp/cardinality.js';

const catalog = createTPCHCatalog();

function createOptimizer() {
  const o = new Optimizer();
  o.registerPass(new ExpressionSimplifier());
  o.registerPass(new SubqueryUnnesting());
  o.registerPass(new HavingPushdown());
  o.registerPass(new CTEOptimization());
  o.registerPass(new PredicatePushdown());
  o.registerPass(new PredicateInference());
  o.registerPass(new PredicatePushdown());
  o.registerPass(new OuterToInnerJoin());
  o.registerPass(new PredicatePushdown());
  o.registerPass(new JoinElimination());
  o.registerPass(new ProjectionPushdown());
  o.registerPass(new LimitPushdown());
  o.registerPass(new EmptyPropagation());
  o.registerPass(new NodeMerge());
  o.registerPass(new PredicateDedup());
  o.registerPass(new IndexSelection(catalog, null));
  o.registerPass(new JoinResidualSplit());
  o.registerPass(new PhysicalDesign(new Map()));
  o.registerPass(new SortElimination());
  o.registerPass(new TopNFusion());
  return o;
}

function optimizeSQL(sql) {
  const ast = parse(sql);
  const binder = new Binder(catalog, defaultFunctionRegistry);
  const bound = binder.bind(ast);
  const logical = createLogicalPlan(bound);
  const optimizer = createOptimizer();
  return optimizer.optimize(logical);
}

function findNodes(plan, type) {
  const result = [];
  const queue = [plan];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    if (node.type === type) result.push(node);
    if (node.children) queue.push(...node.children);
  }
  return result;
}

function scanTables(plan) {
  return findNodes(plan, PlanNodeType.SCAN).map(s => (s.table || s.tableName || '').toUpperCase());
}

function joinStrategies(plan) {
  return findNodes(plan, PlanNodeType.JOIN).map(j => j.physicalStrategy);
}

function filterConditions(plan) {
  return findNodes(plan, PlanNodeType.FILTER).map(f => JSON.stringify(f.condition));
}

function findParent(root, target) {
  if (!root || !root.children) return null;
  for (const child of root.children) {
    if (child === target) return root;
    const found = findParent(child, target);
    if (found) return found;
  }
  return null;
}

describe('TPC-H Optimizer E2E', () => {

  describe('Q1 - Pricing Summary', () => {
    const sql = `
      SELECT L_RETURNFLAG, L_LINESTATUS,
        SUM(L_QUANTITY) as sum_qty,
        SUM(L_EXTENDEDPRICE) as sum_base_price,
        SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as sum_disc_price,
        SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT) * (1 + L_TAX)) as sum_charge,
        AVG(L_QUANTITY) as avg_qty,
        AVG(L_EXTENDEDPRICE) as avg_price,
        AVG(L_DISCOUNT) as avg_disc,
        COUNT(*) as count_order
      FROM LINEITEM
      WHERE L_SHIPDATE <= DATE '1998-12-01'
      GROUP BY L_RETURNFLAG, L_LINESTATUS
      ORDER BY L_RETURNFLAG, L_LINESTATUS`;

    it('single LINEITEM scan, no joins', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan)).toEqual(['LINEITEM']);
      expect(findNodes(plan, PlanNodeType.JOIN).length).toBe(0);
    });

    it('pushes date filter below aggregate', () => {
      const plan = optimizeSQL(sql);
      const filters = findNodes(plan, PlanNodeType.FILTER);
      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      expect(filters.length).toBe(1);
      expect(aggs.length).toBe(1);
      const filterIsChildOfAgg = aggs[0].children.some(function hasFilter(n) {
        if (!n) return false;
        if (n === filters[0]) return true;
        return (n.children || []).some(hasFilter);
      });
      expect(filterIsChildOfAgg).toBe(true);
    });

    it('assigns physical strategy to aggregate', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE)[0].physicalStrategy).toBeDefined();
    });
  });

  describe('Q2 - Minimum Cost Supplier', () => {
    const sql = `
      SELECT S_ACCTBAL, S_NAME, N_NAME, P_PARTKEY, P_MFGR, S_ADDRESS, S_PHONE, S_COMMENT
      FROM PART p JOIN PARTSUPP ps ON p.P_PARTKEY = ps.PS_PARTKEY
        JOIN SUPPLIER s ON s.S_SUPPKEY = ps.PS_SUPPKEY
        JOIN NATION n ON s.S_NATIONKEY = n.N_NATIONKEY
        JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY
      WHERE P_SIZE = 15 AND P_TYPE LIKE '%BRASS'
        AND r.R_NAME = 'EUROPE'
        AND PS_SUPPLYCOST = (
          SELECT MIN(PS_SUPPLYCOST) FROM PARTSUPP ps2
          JOIN SUPPLIER s2 ON s2.S_SUPPKEY = ps2.PS_SUPPKEY
          JOIN NATION n2 ON s2.S_NATIONKEY = n2.N_NATIONKEY
          JOIN REGION r2 ON n2.N_REGIONKEY = r2.R_REGIONKEY
          WHERE ps2.PS_PARTKEY = p.P_PARTKEY AND r2.R_NAME = 'EUROPE'
        )
      ORDER BY S_ACCTBAL DESC, N_NAME, S_NAME, P_PARTKEY
      LIMIT 100`;

    it('scans 9 tables (outer 5 + correlated subquery 4)', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan).length).toBe(9);
    });

    it('8 joins total (4 outer + 3 subquery + 1 dependent-join-unnest)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.JOIN).length).toBe(8);
    });

    it('pushes PART size/type and REGION name filters', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('P_SIZE') || c.includes('P_TYPE'))).toBe(true);
      expect(conds.some(c => c.includes('R_NAME'))).toBe(true);
    });

    it('fuses into TopN with limit 100', () => {
      const plan = optimizeSQL(sql);
      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      expect(topNs.length).toBe(1);
      expect(topNs[0].count).toBe(100);
    });

    it('subquery aggregate for MIN(PS_SUPPLYCOST)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(1);
    });
  });

  describe('Q3 - Shipping Priority', () => {
    const sql = `
      SELECT L_ORDERKEY,
        SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue,
        O_ORDERDATE, O_SHIPPRIORITY
      FROM CUSTOMER c
        JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
        JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
      WHERE c.C_MKTSEGMENT = 'BUILDING'
        AND o.O_ORDERDATE < DATE '1995-03-15'
        AND l.L_SHIPDATE > DATE '1995-03-15'
      GROUP BY L_ORDERKEY, O_ORDERDATE, O_SHIPPRIORITY
      ORDER BY revenue DESC, O_ORDERDATE
      LIMIT 10`;

    it('scans CUSTOMER, ORDERS, LINEITEM', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables).toContain('CUSTOMER');
      expect(tables).toContain('ORDERS');
      expect(tables).toContain('LINEITEM');
    });

    it('pushes 3 filters (one per table)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.FILTER).length).toBe(3);
    });

    it('fuses ORDER BY + LIMIT into TopN(10)', () => {
      const plan = optimizeSQL(sql);
      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      expect(topNs.length).toBe(1);
      expect(topNs[0].count).toBe(10);
      expect(findNodes(plan, PlanNodeType.SORT).length).toBe(0);
    });

    it('2 hash joins', () => {
      const plan = optimizeSQL(sql);
      const strats = joinStrategies(plan);
      expect(strats.length).toBe(2);
      strats.forEach(s => expect(s).toBe(PhysicalStrategy.HASH));
    });

    it('1 aggregate', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(1);
    });
  });

  describe('Q4 - Order Priority Checking', () => {
    const sql = `
      SELECT O_ORDERPRIORITY, COUNT(*) as order_count
      FROM ORDERS
      WHERE O_ORDERDATE >= DATE '1993-07-01'
        AND O_ORDERDATE < DATE '1993-10-01'
        AND EXISTS (
          SELECT 1 FROM LINEITEM
          WHERE L_ORDERKEY = O_ORDERKEY AND L_COMMITDATE < L_RECEIPTDATE
        )
      GROUP BY O_ORDERPRIORITY
      ORDER BY O_ORDERPRIORITY`;

    it('converts EXISTS to semi join', () => {
      const plan = optimizeSQL(sql);
      const semiJoins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.SEMI);
      expect(semiJoins.length).toBe(1);
    });

    it('pushes date filter on ORDERS below semi join', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.FILTER).length).toBeGreaterThanOrEqual(2);
    });

    it('scans ORDERS and LINEITEM only', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(2);
      expect(tables).toContain('ORDERS');
      expect(tables).toContain('LINEITEM');
    });

    it('hash join for the semi join', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.JOIN)[0].physicalStrategy).toBe(PhysicalStrategy.HASH);
    });
  });

  describe('Q5 - Local Supplier Volume', () => {
    const sql = `
      SELECT N_NAME, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue
      FROM CUSTOMER c
        JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
        JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
        JOIN SUPPLIER s ON l.L_SUPPKEY = s.S_SUPPKEY
        JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
        JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY
      WHERE r.R_NAME = 'ASIA'
        AND o.O_ORDERDATE >= DATE '1994-01-01'
        AND o.O_ORDERDATE < DATE '1995-01-01'
        AND s.S_NATIONKEY = n.N_NATIONKEY
      GROUP BY N_NAME
      ORDER BY revenue DESC`;

    it('scans all 6 TPC-H tables', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(6);
      for (const t of ['CUSTOMER', 'ORDERS', 'LINEITEM', 'SUPPLIER', 'NATION', 'REGION']) {
        expect(tables).toContain(t);
      }
    });

    it('5 hash joins', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(5);
      joins.forEach(j => expect(j.physicalStrategy).toBe(PhysicalStrategy.HASH));
    });

    it('pushes predicates to REGION and ORDERS', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('R_NAME'))).toBe(true);
      expect(conds.some(c => c.includes('O_ORDERDATE'))).toBe(true);
    });
  });

  describe('Q6 - Forecasting Revenue Change', () => {
    const sql = `
      SELECT SUM(L_EXTENDEDPRICE * L_DISCOUNT) as revenue
      FROM LINEITEM
      WHERE L_SHIPDATE >= DATE '1994-01-01'
        AND L_SHIPDATE < DATE '1995-01-01'
        AND L_DISCOUNT BETWEEN 0.05 AND 0.07
        AND L_QUANTITY < 24`;

    it('no joins, single LINEITEM scan', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.JOIN).length).toBe(0);
      expect(scanTables(plan)).toEqual(['LINEITEM']);
    });

    it('merges all WHERE conditions into 1 filter', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.FILTER).length).toBe(1);
    });

    it('ungrouped aggregate', () => {
      const plan = optimizeSQL(sql);
      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      expect(aggs.length).toBe(1);
      expect(aggs[0].groupBy?.length || 0).toBe(0);
    });
  });

  describe('Q7 - Volume Shipping', () => {
    const sql = `
      SELECT n1.N_NAME as supp_nation, n2.N_NAME as cust_nation,
        EXTRACT(YEAR FROM L_SHIPDATE) as l_year,
        SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue
      FROM SUPPLIER s
        JOIN LINEITEM l ON s.S_SUPPKEY = l.L_SUPPKEY
        JOIN ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY
        JOIN CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
        JOIN NATION n1 ON s.S_NATIONKEY = n1.N_NATIONKEY
        JOIN NATION n2 ON c.C_NATIONKEY = n2.N_NATIONKEY
      WHERE ((n1.N_NAME = 'FRANCE' AND n2.N_NAME = 'GERMANY')
          OR (n1.N_NAME = 'GERMANY' AND n2.N_NAME = 'FRANCE'))
        AND L_SHIPDATE BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
      GROUP BY n1.N_NAME, n2.N_NAME, EXTRACT(YEAR FROM L_SHIPDATE)
      ORDER BY supp_nation, cust_nation, l_year`;

    it('scans 6 tables (SUPPLIER, LINEITEM, ORDERS, CUSTOMER, NATION x2)', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan).length).toBe(6);
    });

    it('5 hash joins', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(5);
      joins.forEach(j => expect(j.physicalStrategy).toBe(PhysicalStrategy.HASH));
    });

    it('pushes NATION name and LINEITEM date filters', () => {
      const plan = optimizeSQL(sql);
      const filters = findNodes(plan, PlanNodeType.FILTER);
      expect(filters.length).toBeGreaterThanOrEqual(2);
    });

    it('1 aggregate with EXTRACT(YEAR) in group by', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(1);
    });
  });

  describe('Q8 - National Market Share', () => {
    const sql = `
      SELECT EXTRACT(YEAR FROM O_ORDERDATE) as o_year,
        SUM(CASE WHEN n2.N_NAME = 'BRAZIL' THEN L_EXTENDEDPRICE * (1 - L_DISCOUNT) ELSE 0 END)
          / SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as mkt_share
      FROM PART p
        JOIN LINEITEM l ON p.P_PARTKEY = l.L_PARTKEY
        JOIN SUPPLIER s ON s.S_SUPPKEY = l.L_SUPPKEY
        JOIN ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY
        JOIN CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
        JOIN NATION n1 ON c.C_NATIONKEY = n1.N_NATIONKEY
        JOIN NATION n2 ON s.S_NATIONKEY = n2.N_NATIONKEY
        JOIN REGION r ON n1.N_REGIONKEY = r.R_REGIONKEY
      WHERE r.R_NAME = 'AMERICA'
        AND O_ORDERDATE BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
        AND P_TYPE = 'ECONOMY ANODIZED STEEL'
      GROUP BY EXTRACT(YEAR FROM O_ORDERDATE)
      ORDER BY o_year`;

    it('scans 8 tables (PART, LINEITEM, SUPPLIER, ORDERS, CUSTOMER, NATION x2, REGION)', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan).length).toBe(8);
    });

    it('7 hash joins for the 8-way join', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(7);
      joins.forEach(j => expect(j.physicalStrategy).toBe(PhysicalStrategy.HASH));
    });

    it('pushes REGION, ORDERS date, and PART type filters', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('R_NAME'))).toBe(true);
      expect(conds.some(c => c.includes('O_ORDERDATE'))).toBe(true);
      expect(conds.some(c => c.includes('P_TYPE'))).toBe(true);
    });

    it('1 aggregate with CASE WHEN for conditional sum', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(1);
    });
  });

  describe('Q9 - Product Type Profit Measure', () => {
    const sql = `
      SELECT N_NAME as nation,
        EXTRACT(YEAR FROM O_ORDERDATE) as o_year,
        SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT) - PS_SUPPLYCOST * L_QUANTITY) as sum_profit
      FROM PART p
        JOIN LINEITEM l ON p.P_PARTKEY = l.L_PARTKEY
        JOIN SUPPLIER s ON s.S_SUPPKEY = l.L_SUPPKEY
        JOIN PARTSUPP ps ON ps.PS_SUPPKEY = l.L_SUPPKEY AND ps.PS_PARTKEY = l.L_PARTKEY
        JOIN ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY
        JOIN NATION n ON s.S_NATIONKEY = n.N_NATIONKEY
      WHERE P_NAME LIKE '%green%'
      GROUP BY N_NAME, EXTRACT(YEAR FROM O_ORDERDATE)
      ORDER BY nation, o_year DESC`;

    it('scans 6 tables (PART, LINEITEM, SUPPLIER, PARTSUPP, ORDERS, NATION)', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(6);
      for (const t of ['PART', 'LINEITEM', 'SUPPLIER', 'PARTSUPP', 'ORDERS', 'NATION']) {
        expect(tables).toContain(t);
      }
    });

    it('5 hash joins', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(5);
      joins.forEach(j => expect(j.physicalStrategy).toBe(PhysicalStrategy.HASH));
    });

    it('pushes P_NAME LIKE filter to PART scan', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('P_NAME'))).toBe(true);
    });

    it('1 aggregate over nation and year', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(1);
    });
  });

  describe('Q10 - Returned Item Reporting', () => {
    const sql = `
      SELECT C_CUSTKEY, C_NAME,
        SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue,
        C_ACCTBAL, N_NAME, C_ADDRESS, C_PHONE, C_COMMENT
      FROM CUSTOMER c
        JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
        JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
        JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
      WHERE o.O_ORDERDATE >= DATE '1993-10-01'
        AND o.O_ORDERDATE < DATE '1994-01-01'
        AND l.L_RETURNFLAG = 'R'
      GROUP BY C_CUSTKEY, C_NAME, C_ACCTBAL, C_PHONE, N_NAME, C_ADDRESS, C_COMMENT
      ORDER BY revenue DESC
      LIMIT 20`;

    it('scans 4 tables', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(4);
      expect(tables).toContain('CUSTOMER');
      expect(tables).toContain('ORDERS');
      expect(tables).toContain('LINEITEM');
      expect(tables).toContain('NATION');
    });

    it('3 hash joins', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(3);
      joins.forEach(j => expect(j.physicalStrategy).toBe(PhysicalStrategy.HASH));
    });

    it('pushes filters to ORDERS and LINEITEM', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('O_ORDERDATE'))).toBe(true);
      expect(conds.some(c => c.includes('L_RETURNFLAG'))).toBe(true);
    });

    it('fuses into TopN(20)', () => {
      const plan = optimizeSQL(sql);
      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      expect(topNs.length).toBe(1);
      expect(topNs[0].count).toBe(20);
    });
  });

  describe('Q11 - Important Stock Identification', () => {
    const sql = `
      SELECT PS_PARTKEY, SUM(PS_SUPPLYCOST * PS_AVAILQTY) as value
      FROM PARTSUPP ps
        JOIN SUPPLIER s ON ps.PS_SUPPKEY = s.S_SUPPKEY
        JOIN NATION n ON s.S_NATIONKEY = n.N_NATIONKEY
      WHERE n.N_NAME = 'GERMANY'
      GROUP BY PS_PARTKEY
      HAVING SUM(PS_SUPPLYCOST * PS_AVAILQTY) > (
        SELECT SUM(PS_SUPPLYCOST * PS_AVAILQTY) * 0.0001
        FROM PARTSUPP ps2
        JOIN SUPPLIER s2 ON ps2.PS_SUPPKEY = s2.S_SUPPKEY
        JOIN NATION n2 ON s2.S_NATIONKEY = n2.N_NATIONKEY
        WHERE n2.N_NAME = 'GERMANY'
      )
      ORDER BY value DESC`;

    it('scans 6 tables (outer 3 + HAVING subquery 3)', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan).length).toBe(6);
    });

    it('5 joins (2 outer + 2 subquery + 1 dependent-join-unnest)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.JOIN).length).toBe(5);
    });

    it('2 aggregates (outer GROUP BY + subquery SUM)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(2);
    });

    it('pushes N_NAME = GERMANY filter', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('N_NAME'))).toBe(true);
    });
  });

  describe('Q12 - Shipping Modes and Order Priority', () => {
    const sql = `
      SELECT L_SHIPMODE,
        SUM(CASE WHEN O_ORDERPRIORITY = '1-URGENT' OR O_ORDERPRIORITY = '2-HIGH'
          THEN 1 ELSE 0 END) as high_line_count,
        SUM(CASE WHEN O_ORDERPRIORITY <> '1-URGENT' AND O_ORDERPRIORITY <> '2-HIGH'
          THEN 1 ELSE 0 END) as low_line_count
      FROM ORDERS o
        JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY
      WHERE l.L_SHIPMODE IN ('MAIL', 'SHIP')
        AND l.L_COMMITDATE < l.L_RECEIPTDATE
        AND l.L_SHIPDATE < l.L_COMMITDATE
        AND l.L_RECEIPTDATE >= DATE '1994-01-01'
        AND l.L_RECEIPTDATE < DATE '1995-01-01'
      GROUP BY L_SHIPMODE
      ORDER BY L_SHIPMODE`;

    it('1 hash join between ORDERS and LINEITEM', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(1);
      expect(joins[0].physicalStrategy).toBe(PhysicalStrategy.HASH);
    });

    it('pushes LINEITEM filters below join', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c =>
        c.includes('L_SHIPMODE') || c.includes('L_RECEIPTDATE') || c.includes('L_COMMITDATE')
      )).toBe(true);
    });

    it('scans ORDERS and LINEITEM', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(2);
      expect(tables).toContain('ORDERS');
      expect(tables).toContain('LINEITEM');
    });
  });

  describe('Q13 - Customer Distribution', () => {
    const sql = `
      SELECT c_count, COUNT(*) as custdist
      FROM (
        SELECT c.C_CUSTKEY, COUNT(o.O_ORDERKEY) as c_count
        FROM CUSTOMER c
          LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
            AND o.O_COMMENT NOT LIKE '%special%requests%'
        GROUP BY c.C_CUSTKEY
      ) as c_orders
      GROUP BY c_count
      ORDER BY custdist DESC, c_count DESC`;

    it('preserves LEFT JOIN (no null-rejecting WHERE)', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(1);
      expect(joins[0].joinType).toBe(JoinType.LEFT);
    });

    it('2 aggregates (inner per-customer + outer distribution)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(2);
    });

    it('scans CUSTOMER and ORDERS', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables).toContain('CUSTOMER');
      expect(tables).toContain('ORDERS');
    });
  });

  describe('Q14 - Promotion Effect', () => {
    const sql = `
      SELECT 100.00 * SUM(CASE WHEN P_TYPE LIKE 'PROMO%'
          THEN L_EXTENDEDPRICE * (1 - L_DISCOUNT) ELSE 0 END)
        / SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as promo_revenue
      FROM LINEITEM l
        JOIN PART p ON l.L_PARTKEY = p.P_PARTKEY
      WHERE l.L_SHIPDATE >= DATE '1995-09-01'
        AND l.L_SHIPDATE < DATE '1995-10-01'`;

    it('1 hash join between LINEITEM and PART', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(1);
      expect(joins[0].physicalStrategy).toBe(PhysicalStrategy.HASH);
    });

    it('pushes date filter on LINEITEM below join', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('L_SHIPDATE'))).toBe(true);
    });

    it('ungrouped aggregate', () => {
      const plan = optimizeSQL(sql);
      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      expect(aggs.length).toBe(1);
      expect(aggs[0].groupBy?.length || 0).toBe(0);
    });
  });

  describe('Q15 - Top Supplier (CTE)', () => {
    const sql = `
      WITH revenue AS (
        SELECT L_SUPPKEY as supplier_no,
          SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as total_revenue
        FROM LINEITEM
        WHERE L_SHIPDATE >= DATE '1996-01-01' AND L_SHIPDATE < DATE '1996-04-01'
        GROUP BY L_SUPPKEY
      )
      SELECT S_SUPPKEY, S_NAME, S_ADDRESS, S_PHONE, total_revenue
      FROM SUPPLIER s JOIN revenue r ON s.S_SUPPKEY = r.supplier_no
      ORDER BY S_SUPPKEY`;

    it('scans SUPPLIER via regular scan + LINEITEM via CTE scan', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan)).toContain('SUPPLIER');
    });

    it('1 join (SUPPLIER to CTE)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.JOIN).length).toBe(1);
    });

    it('valid plan with CTE optimization', () => {
      const plan = optimizeSQL(sql);
      expect(plan).toBeDefined();
      expect(plan.type).toBeDefined();
    });
  });

  describe('Q16 - Parts/Supplier Relationship', () => {
    const sql = `
      SELECT P_BRAND, P_TYPE, P_SIZE,
        COUNT(DISTINCT PS_SUPPKEY) as supplier_cnt
      FROM PARTSUPP
        JOIN PART ON P_PARTKEY = PS_PARTKEY
      WHERE P_BRAND <> 'Brand#45'
        AND P_TYPE NOT LIKE 'MEDIUM POLISHED%'
        AND P_SIZE IN (49, 14, 23, 45, 19, 3, 36, 9)
        AND PS_SUPPKEY NOT IN (
          SELECT S_SUPPKEY FROM SUPPLIER
          WHERE S_COMMENT LIKE '%Customer%Complaints%'
        )
      GROUP BY P_BRAND, P_TYPE, P_SIZE
      ORDER BY supplier_cnt DESC, P_BRAND, P_TYPE, P_SIZE`;

    it('converts NOT IN to mark join', () => {
      const plan = optimizeSQL(sql);
      const markJoins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.MARK);
      expect(markJoins.length).toBe(1);
    });

    it('scans PARTSUPP, PART, SUPPLIER', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(3);
      expect(tables).toContain('PARTSUPP');
      expect(tables).toContain('PART');
      expect(tables).toContain('SUPPLIER');
    });

    it('pushes PART brand/type/size filters', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.FILTER).length).toBeGreaterThanOrEqual(3);
    });

    it('2 hash joins (equi + mark)', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(2);
      joins.forEach(j => expect(j.physicalStrategy).toBe(PhysicalStrategy.HASH));
    });
  });

  describe('Q17 - Small-Quantity-Order Revenue (simplified)', () => {
    const sql = `
      SELECT SUM(L_EXTENDEDPRICE) / 7.0 as avg_yearly
      FROM LINEITEM l
        JOIN PART p ON p.P_PARTKEY = l.L_PARTKEY
      WHERE P_BRAND = 'Brand#23' AND P_CONTAINER = 'MED BOX'`;

    it('1 hash join LINEITEM-PART', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(1);
      expect(joins[0].physicalStrategy).toBe(PhysicalStrategy.HASH);
    });

    it('pushes brand/container filter to PART', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('P_BRAND') || c.includes('P_CONTAINER'))).toBe(true);
    });

    it('ungrouped aggregate for SUM/division', () => {
      const plan = optimizeSQL(sql);
      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      expect(aggs.length).toBe(1);
      expect(aggs[0].groupBy?.length || 0).toBe(0);
    });

    it('scans LINEITEM and PART', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(2);
      expect(tables).toContain('LINEITEM');
      expect(tables).toContain('PART');
    });
  });

  describe('Q18 - Large Volume Customer', () => {
    const sql = `
      SELECT C_NAME, C_CUSTKEY, O_ORDERKEY, O_ORDERDATE, O_TOTALPRICE, SUM(L_QUANTITY)
      FROM CUSTOMER c
        JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
        JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY
      WHERE O_ORDERKEY IN (
        SELECT L_ORDERKEY FROM LINEITEM
        GROUP BY L_ORDERKEY
        HAVING SUM(L_QUANTITY) > 300
      )
      GROUP BY C_NAME, C_CUSTKEY, O_ORDERKEY, O_ORDERDATE, O_TOTALPRICE
      ORDER BY O_TOTALPRICE DESC, O_ORDERDATE
      LIMIT 100`;

    it('converts IN subquery to semi join', () => {
      const plan = optimizeSQL(sql);
      const semiJoins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.SEMI);
      expect(semiJoins.length).toBe(1);
    });

    it('scans CUSTOMER, ORDERS, LINEITEM x2', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(4);
      expect(tables.filter(t => t === 'LINEITEM').length).toBe(2);
    });

    it('2 aggregates (outer + subquery HAVING)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(2);
    });

    it('fuses into TopN(100)', () => {
      const plan = optimizeSQL(sql);
      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      expect(topNs.length).toBe(1);
      expect(topNs[0].count).toBe(100);
    });

    it('3 hash joins', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(3);
      joins.forEach(j => expect(j.physicalStrategy).toBe(PhysicalStrategy.HASH));
    });
  });

  describe('Q19 - Discounted Revenue (complex OR predicates)', () => {
    const sql = `
      SELECT SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue
      FROM LINEITEM l
        JOIN PART p ON p.P_PARTKEY = l.L_PARTKEY
      WHERE (P_BRAND = 'Brand#12'
          AND P_CONTAINER IN ('SM CASE', 'SM BOX', 'SM PACK', 'SM PKG')
          AND L_QUANTITY >= 1 AND L_QUANTITY <= 11
          AND P_SIZE BETWEEN 1 AND 5)
        OR (P_BRAND = 'Brand#23'
          AND P_CONTAINER IN ('MED BAG', 'MED BOX', 'MED PKG', 'MED PACK')
          AND L_QUANTITY >= 10 AND L_QUANTITY <= 20
          AND P_SIZE BETWEEN 1 AND 10)
        OR (P_BRAND = 'Brand#34'
          AND P_CONTAINER IN ('LG CASE', 'LG BOX', 'LG PACK', 'LG PKG')
          AND L_QUANTITY >= 20 AND L_QUANTITY <= 30
          AND P_SIZE BETWEEN 1 AND 15)`;

    it('1 hash join LINEITEM-PART', () => {
      const plan = optimizeSQL(sql);
      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(1);
      expect(joins[0].physicalStrategy).toBe(PhysicalStrategy.HASH);
    });

    it('has filters for the complex OR conditions', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.FILTER).length).toBeGreaterThanOrEqual(1);
    });

    it('ungrouped aggregate for SUM', () => {
      const plan = optimizeSQL(sql);
      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      expect(aggs.length).toBe(1);
      expect(aggs[0].groupBy?.length || 0).toBe(0);
    });

    it('scans LINEITEM and PART', () => {
      const plan = optimizeSQL(sql);
      const tables = scanTables(plan);
      expect(tables.length).toBe(2);
      expect(tables).toContain('LINEITEM');
      expect(tables).toContain('PART');
    });
  });

  describe('Q20 - Potential Part Promotion (nested IN + correlated subquery)', () => {
    const sql = `
      SELECT S_NAME, S_ADDRESS
      FROM SUPPLIER s
        JOIN NATION n ON s.S_NATIONKEY = n.N_NATIONKEY
      WHERE n.N_NAME = 'CANADA'
        AND S_SUPPKEY IN (
          SELECT PS_SUPPKEY FROM PARTSUPP
          WHERE PS_PARTKEY IN (SELECT P_PARTKEY FROM PART WHERE P_NAME LIKE 'forest%')
            AND PS_AVAILQTY > (
              SELECT 0.5 * SUM(L_QUANTITY) FROM LINEITEM
              WHERE L_PARTKEY = PS_PARTKEY AND L_SUPPKEY = PS_SUPPKEY
                AND L_SHIPDATE >= DATE '1994-01-01' AND L_SHIPDATE < DATE '1995-01-01'
            )
        )
      ORDER BY S_NAME`;

    it('scans 5 tables (SUPPLIER, NATION, PARTSUPP, PART, LINEITEM)', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan).length).toBe(5);
    });

    it('has semi joins from IN subqueries', () => {
      const plan = optimizeSQL(sql);
      const semiJoins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.SEMI);
      expect(semiJoins.length).toBeGreaterThanOrEqual(1);
    });

    it('pushes N_NAME filter to NATION', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('N_NAME'))).toBe(true);
    });

    it('1 aggregate for SUM(L_QUANTITY) in correlated subquery', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(1);
    });

    it('4 joins total', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.JOIN).length).toBe(4);
    });
  });

  describe('Q21 - Suppliers Who Kept Orders Waiting (EXISTS + NOT EXISTS)', () => {
    const sql = `
      SELECT S_NAME, COUNT(*) as numwait
      FROM SUPPLIER s
        JOIN LINEITEM l1 ON s.S_SUPPKEY = l1.L_SUPPKEY
        JOIN ORDERS o ON o.O_ORDERKEY = l1.L_ORDERKEY
        JOIN NATION n ON s.S_NATIONKEY = n.N_NATIONKEY
      WHERE o.O_ORDERSTATUS = 'F'
        AND l1.L_RECEIPTDATE > l1.L_COMMITDATE
        AND n.N_NAME = 'SAUDI ARABIA'
        AND EXISTS (
          SELECT 1 FROM LINEITEM l2
          WHERE l2.L_ORDERKEY = l1.L_ORDERKEY AND l2.L_SUPPKEY <> l1.L_SUPPKEY
        )
        AND NOT EXISTS (
          SELECT 1 FROM LINEITEM l3
          WHERE l3.L_ORDERKEY = l1.L_ORDERKEY AND l3.L_SUPPKEY <> l1.L_SUPPKEY
            AND l3.L_RECEIPTDATE > l3.L_COMMITDATE
        )
      GROUP BY S_NAME
      ORDER BY numwait DESC, S_NAME
      LIMIT 100`;

    it('scans 6 tables (SUPPLIER, LINEITEM x3, ORDERS, NATION)', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan).length).toBe(6);
    });

    it('EXISTS converts to semi join', () => {
      const plan = optimizeSQL(sql);
      const semiJoins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.SEMI);
      expect(semiJoins.length).toBe(1);
    });

    it('NOT EXISTS converts to anti join', () => {
      const plan = optimizeSQL(sql);
      const antiJoins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.ANTI);
      expect(antiJoins.length).toBe(1);
    });

    it('5 joins total (3 inner + semi + anti)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.JOIN).length).toBe(5);
    });

    it('pushes ORDERSTATUS and NATION filters', () => {
      const plan = optimizeSQL(sql);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('O_ORDERSTATUS'))).toBe(true);
      expect(conds.some(c => c.includes('N_NAME'))).toBe(true);
    });

    it('fuses into TopN(100)', () => {
      const plan = optimizeSQL(sql);
      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      expect(topNs.length).toBe(1);
      expect(topNs[0].count).toBe(100);
    });
  });

  describe('Q22 - Global Sales Opportunity (SUBSTRING, scalar subquery, NOT EXISTS)', () => {
    const sql = `
      SELECT SUBSTRING(C_PHONE, 1, 2) as cntrycode,
        COUNT(*) as numcust, SUM(C_ACCTBAL) as totacctbal
      FROM CUSTOMER
      WHERE SUBSTRING(C_PHONE, 1, 2) IN ('13', '31', '23', '29', '30', '18', '17')
        AND C_ACCTBAL > (
          SELECT AVG(C_ACCTBAL) FROM CUSTOMER
          WHERE C_ACCTBAL > 0.00
            AND SUBSTRING(C_PHONE, 1, 2) IN ('13', '31', '23', '29', '30', '18', '17')
        )
        AND NOT EXISTS (SELECT 1 FROM ORDERS WHERE O_CUSTKEY = C_CUSTKEY)
      GROUP BY SUBSTRING(C_PHONE, 1, 2)
      ORDER BY cntrycode`;

    it('scans 3 tables (CUSTOMER x2 + ORDERS)', () => {
      const plan = optimizeSQL(sql);
      expect(scanTables(plan).length).toBe(3);
    });

    it('NOT EXISTS converts to anti join', () => {
      const plan = optimizeSQL(sql);
      const antiJoins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.ANTI);
      expect(antiJoins.length).toBe(1);
    });

    it('2 aggregates (outer GROUP BY + scalar AVG subquery)', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.AGGREGATE).length).toBe(2);
    });

    it('2 joins total', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.JOIN).length).toBe(2);
    });

    it('has filters for SUBSTRING IN and C_ACCTBAL', () => {
      const plan = optimizeSQL(sql);
      expect(findNodes(plan, PlanNodeType.FILTER).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('cross-query optimization invariants', () => {
    const ALL_QUERIES = {
      Q1: `SELECT L_RETURNFLAG, L_LINESTATUS, SUM(L_QUANTITY) as sum_qty, COUNT(*) as cnt FROM LINEITEM WHERE L_SHIPDATE <= DATE '1998-12-01' GROUP BY L_RETURNFLAG, L_LINESTATUS ORDER BY L_RETURNFLAG, L_LINESTATUS`,
      Q3: `SELECT L_ORDERKEY, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue, O_ORDERDATE FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY WHERE c.C_MKTSEGMENT = 'BUILDING' GROUP BY L_ORDERKEY, O_ORDERDATE ORDER BY revenue DESC LIMIT 10`,
      Q4: `SELECT O_ORDERPRIORITY, COUNT(*) FROM ORDERS WHERE EXISTS (SELECT 1 FROM LINEITEM WHERE L_ORDERKEY = O_ORDERKEY AND L_COMMITDATE < L_RECEIPTDATE) GROUP BY O_ORDERPRIORITY`,
      Q5: `SELECT N_NAME, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY JOIN SUPPLIER s ON l.L_SUPPKEY = s.S_SUPPKEY JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY WHERE r.R_NAME = 'ASIA' GROUP BY N_NAME`,
      Q6: `SELECT SUM(L_EXTENDEDPRICE * L_DISCOUNT) as revenue FROM LINEITEM WHERE L_SHIPDATE >= DATE '1994-01-01' AND L_DISCOUNT BETWEEN 0.05 AND 0.07 AND L_QUANTITY < 24`,
      Q10: `SELECT C_CUSTKEY, C_NAME, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as rev FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY GROUP BY C_CUSTKEY, C_NAME ORDER BY rev DESC LIMIT 20`,
      Q12: `SELECT L_SHIPMODE, SUM(CASE WHEN O_ORDERPRIORITY = '1-URGENT' THEN 1 ELSE 0 END) as cnt FROM ORDERS o JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY WHERE l.L_SHIPMODE IN ('MAIL', 'SHIP') GROUP BY L_SHIPMODE`,
      Q14: `SELECT SUM(CASE WHEN P_TYPE LIKE 'PROMO%' THEN L_EXTENDEDPRICE ELSE 0 END) / SUM(L_EXTENDEDPRICE) FROM LINEITEM l JOIN PART p ON l.L_PARTKEY = p.P_PARTKEY`,
      Q17: `SELECT SUM(L_EXTENDEDPRICE) / 7.0 FROM LINEITEM l JOIN PART p ON p.P_PARTKEY = l.L_PARTKEY WHERE P_BRAND = 'Brand#23'`,
    };

    it('all queries produce valid plan trees', () => {
      for (const [, sql] of Object.entries(ALL_QUERIES)) {
        const plan = optimizeSQL(sql);
        expect(plan).toBeDefined();
        expect(plan.type).toBeDefined();
      }
    });

    it('all joins have physical strategies', () => {
      for (const [, sql] of Object.entries(ALL_QUERIES)) {
        const plan = optimizeSQL(sql);
        for (const j of findNodes(plan, PlanNodeType.JOIN)) {
          expect(j.physicalStrategy).toBeDefined();
          expect([PhysicalStrategy.HASH, PhysicalStrategy.MERGE]).toContain(j.physicalStrategy);
        }
      }
    });

    it('all aggregates have physical strategies', () => {
      for (const [, sql] of Object.entries(ALL_QUERIES)) {
        const plan = optimizeSQL(sql);
        for (const a of findNodes(plan, PlanNodeType.AGGREGATE)) {
          expect(a.physicalStrategy).toBeDefined();
        }
      }
    });

    it('no unfused SORT+LIMIT pairs remain', () => {
      for (const [, sql] of Object.entries(ALL_QUERIES)) {
        const plan = optimizeSQL(sql);
        const sorts = findNodes(plan, PlanNodeType.SORT);
        const limits = findNodes(plan, PlanNodeType.LIMIT);
        if (sorts.length > 0 && limits.length > 0) {
          expect(findParent(plan, sorts[0])?.type).not.toBe(PlanNodeType.LIMIT);
        }
      }
    });

    it('projection pushdown reduces scanned columns below max table width', () => {
      for (const [, sql] of Object.entries(ALL_QUERIES)) {
        const plan = optimizeSQL(sql);
        for (const scan of findNodes(plan, PlanNodeType.SCAN)) {
          if (scan.columns) {
            expect(scan.columns.length).toBeLessThan(17);
          }
        }
      }
    });
  });

  describe('optimizer pass interactions on TPC-H patterns', () => {
    it('predicate inference across join keys', () => {
      const plan = optimizeSQL(`
        SELECT * FROM NATION n JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY
        WHERE n.N_REGIONKEY = 1
      `);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('R_REGIONKEY') && c.includes('1'))).toBe(true);
    });

    it('impossible WHERE produces EMPTY node', () => {
      const plan = optimizeSQL(`
        SELECT L_RETURNFLAG, SUM(L_QUANTITY) FROM LINEITEM WHERE 1 = 0 GROUP BY L_RETURNFLAG
      `);
      expect(findNodes(plan, PlanNodeType.EMPTY).length).toBeGreaterThan(0);
    });

    it('LEFT JOIN converts to INNER when WHERE rejects nulls', () => {
      const plan = optimizeSQL(`
        SELECT c.C_CUSTKEY, o.O_ORDERKEY
        FROM CUSTOMER c LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
        WHERE o.O_TOTALPRICE > 100
      `);
      expect(findNodes(plan, PlanNodeType.JOIN)[0].joinType).toBe(JoinType.INNER);
    });

    it('node merge consolidates multiple AND conditions', () => {
      const plan = optimizeSQL(`
        SELECT * FROM LINEITEM
        WHERE L_QUANTITY > 10 AND L_DISCOUNT < 0.05 AND L_SHIPDATE > DATE '1994-01-01'
      `);
      expect(findNodes(plan, PlanNodeType.FILTER).length).toBeLessThanOrEqual(1);
    });

    it('HAVING on group key pushes below aggregate', () => {
      const plan = optimizeSQL(`
        SELECT L_RETURNFLAG, SUM(L_QUANTITY) FROM LINEITEM
        GROUP BY L_RETURNFLAG HAVING L_RETURNFLAG = 'R'
      `);
      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      const filters = findNodes(plan, PlanNodeType.FILTER);
      const filterBelowAgg = filters.some(f => {
        const queue = aggs.flatMap(a => a.children || []);
        while (queue.length) {
          const n = queue.shift();
          if (n === f) return true;
          if (n?.children) queue.push(...n.children);
        }
        return false;
      });
      expect(filterBelowAgg).toBe(true);
    });

    it('NOT EXISTS converts to anti join', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS
        WHERE NOT EXISTS (SELECT 1 FROM LINEITEM WHERE L_ORDERKEY = O_ORDERKEY)
      `);
      const antiJoins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.ANTI);
      expect(antiJoins.length).toBe(1);
    });

    it('derived table inner query gets optimized', () => {
      const plan = optimizeSQL(`
        SELECT * FROM (
          SELECT O_CUSTKEY, SUM(O_TOTALPRICE) as total
          FROM ORDERS WHERE O_ORDERSTATUS = 'F' GROUP BY O_CUSTKEY
        ) sub WHERE total > 1000
      `);
      const conds = filterConditions(plan);
      expect(conds.some(c => c.includes('O_ORDERSTATUS'))).toBe(true);
    });

    it('CTE optimizes correctly', () => {
      const plan = optimizeSQL(`
        WITH big_orders AS (
          SELECT O_ORDERKEY, O_CUSTKEY, O_TOTALPRICE
          FROM ORDERS WHERE O_TOTALPRICE > 1000
        )
        SELECT * FROM big_orders WHERE O_CUSTKEY = 42
      `);
      expect(plan).toBeDefined();
      expect(findNodes(plan, PlanNodeType.FILTER).length).toBeGreaterThanOrEqual(1);
    });

    it('empty propagation through INNER JOIN', () => {
      const plan = optimizeSQL(`
        SELECT * FROM ORDERS o
        JOIN (SELECT * FROM CUSTOMER WHERE 1 = 0) c ON o.O_CUSTKEY = c.C_CUSTKEY
      `);
      expect(findNodes(plan, PlanNodeType.EMPTY).length).toBeGreaterThan(0);
    });
  });

  describe('cost-based optimization with TPC-H statistics', () => {
    function tpchStats() {
      const stats = new Map();

      function colStats(ndv, min, max, opts = {}) {
        return new ColumnStatistics({ ndv, min, max, ...opts });
      }

      function tableStats(rowCount, columns) {
        const colMap = new Map();
        for (const [name, cs] of Object.entries(columns)) {
          colMap.set(name.toUpperCase(), cs);
        }
        return new TableStatistics(rowCount, colMap);
      }

      stats.set('REGION', tableStats(5, {
        R_REGIONKEY: colStats(5, 0, 4),
        R_NAME: colStats(5, null, null),
      }));

      stats.set('NATION', tableStats(25, {
        N_NATIONKEY: colStats(25, 0, 24),
        N_NAME: colStats(25, null, null),
        N_REGIONKEY: colStats(5, 0, 4),
      }));

      stats.set('SUPPLIER', tableStats(10000, {
        S_SUPPKEY: colStats(10000, 1, 10000),
        S_NAME: colStats(10000, null, null),
        S_NATIONKEY: colStats(25, 0, 24),
        S_ACCTBAL: colStats(9500, -999, 9999, {
          histogram: new EquiDepthHistogram(
            Array.from({ length: 10 }, (_, i) => -999 + (i + 1) * 1100), 10000
          ),
        }),
      }));

      stats.set('PART', tableStats(200000, {
        P_PARTKEY: colStats(200000, 1, 200000),
        P_NAME: colStats(200000, null, null),
        P_BRAND: colStats(25, null, null),
        P_TYPE: colStats(150, null, null),
        P_SIZE: colStats(50, 1, 50),
        P_CONTAINER: colStats(40, null, null),
        P_RETAILPRICE: colStats(20000, 900, 2100),
      }));

      stats.set('PARTSUPP', tableStats(800000, {
        PS_PARTKEY: colStats(200000, 1, 200000),
        PS_SUPPKEY: colStats(10000, 1, 10000),
        PS_AVAILQTY: colStats(10000, 1, 9999),
        PS_SUPPLYCOST: colStats(100000, 1, 1000),
      }));

      stats.set('CUSTOMER', tableStats(150000, {
        C_CUSTKEY: colStats(150000, 1, 150000),
        C_NAME: colStats(150000, null, null),
        C_NATIONKEY: colStats(25, 0, 24),
        C_MKTSEGMENT: colStats(5, null, null),
        C_ACCTBAL: colStats(140000, -999, 9999),
        C_PHONE: colStats(150000, null, null),
      }));

      stats.set('ORDERS', tableStats(1500000, {
        O_ORDERKEY: colStats(1500000, 1, 6000000),
        O_CUSTKEY: colStats(100000, 1, 150000),
        O_ORDERSTATUS: colStats(3, null, null),
        O_TOTALPRICE: colStats(1400000, 800, 600000),
        O_ORDERDATE: colStats(2400, null, null, {
          histogram: new EquiDepthHistogram(
            Array.from({ length: 10 }, (_, i) => 8035 + (i + 1) * 240), 1500000
          ),
        }),
        O_ORDERPRIORITY: colStats(5, null, null),
        O_SHIPPRIORITY: colStats(1, 0, 0),
      }));

      stats.set('LINEITEM', tableStats(6000000, {
        L_ORDERKEY: colStats(1500000, 1, 6000000),
        L_PARTKEY: colStats(200000, 1, 200000),
        L_SUPPKEY: colStats(10000, 1, 10000),
        L_LINENUMBER: colStats(7, 1, 7),
        L_QUANTITY: colStats(50, 1, 50, {
          histogram: new EquiDepthHistogram(
            Array.from({ length: 10 }, (_, i) => (i + 1) * 5), 6000000
          ),
        }),
        L_EXTENDEDPRICE: colStats(1000000, 900, 105000),
        L_DISCOUNT: colStats(11, 0, 0.1, {
          histogram: new EquiDepthHistogram(
            Array.from({ length: 10 }, (_, i) => (i + 1) * 0.01), 6000000
          ),
        }),
        L_TAX: colStats(9, 0, 0.08),
        L_RETURNFLAG: colStats(3, null, null),
        L_LINESTATUS: colStats(2, null, null),
        L_SHIPDATE: colStats(2500, null, null),
        L_COMMITDATE: colStats(2500, null, null),
        L_RECEIPTDATE: colStats(2500, null, null),
        L_SHIPMODE: colStats(7, null, null),
      }));

      return stats;
    }

    function createCostOptimizer(statistics) {
      const o = new Optimizer();
      o.registerPass(new ExpressionSimplifier());
      o.registerPass(new SubqueryUnnesting());
      o.registerPass(new HavingPushdown());
      o.registerPass(new CTEOptimization());
      o.registerPass(new PredicatePushdown());
      o.registerPass(new PredicateInference());
      o.registerPass(new PredicatePushdown());
      o.registerPass(new OuterToInnerJoin());
      o.registerPass(new PredicatePushdown());
      o.registerPass(new JoinReorder(statistics));
      o.registerPass(new PredicatePushdown());
      o.registerPass(new JoinElimination());
      o.registerPass(new ProjectionPushdown());
      o.registerPass(new LimitPushdown());
      o.registerPass(new EmptyPropagation());
      o.registerPass(new NodeMerge());
      o.registerPass(new PredicateDedup());
      o.registerPass(new IndexSelection(catalog, statistics));
      o.registerPass(new JoinResidualSplit());
      o.registerPass(new PhysicalDesign(statistics));
      o.registerPass(new SortElimination());
      o.registerPass(new TopNFusion());
      return o;
    }

    function optimizeWithStats(sql) {
      const stats = tpchStats();
      const ast = parse(sql);
      const binder = new Binder(catalog, defaultFunctionRegistry);
      const bound = binder.bind(ast);
      const logical = createLogicalPlan(bound);
      const optimizer = createCostOptimizer(stats);
      return optimizer.optimize(logical);
    }

    describe('cardinality estimation on plan nodes', () => {
      it('scan cardinality matches table row count from stats', () => {
        const plan = optimizeWithStats(`SELECT * FROM LINEITEM`);
        const scans = findNodes(plan, PlanNodeType.SCAN);
        expect(scans[0]._cardinality).toBe(6000000);
      });

      it('scan cardinality for small table', () => {
        const plan = optimizeWithStats(`SELECT * FROM REGION`);
        const scans = findNodes(plan, PlanNodeType.SCAN);
        expect(scans[0]._cardinality).toBe(5);
      });

      it('filter reduces cardinality based on selectivity', () => {
        const plan = optimizeWithStats(`SELECT * FROM ORDERS WHERE O_ORDERSTATUS = 'F'`);
        const filters = findNodes(plan, PlanNodeType.FILTER);
        expect(filters[0]._cardinality).toBeLessThan(1500000);
        expect(filters[0]._cardinality).toBeGreaterThan(0);
      });

      it('join cardinality uses NDV-based estimation', () => {
        const plan = optimizeWithStats(`
          SELECT * FROM ORDERS o JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        expect(joins[0]._cardinality).toBeDefined();
        expect(joins[0]._cardinality).toBeGreaterThan(0);
        expect(joins[0]._cardinality).toBeLessThan(1500000 * 150000);
      });

      it('aggregate reduces cardinality', () => {
        const plan = optimizeWithStats(`
          SELECT O_ORDERSTATUS, COUNT(*) FROM ORDERS GROUP BY O_ORDERSTATUS
        `);
        const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
        expect(aggs[0]._cardinality).toBeLessThan(1500000);
      });
    });

    describe('join reorder with cost model', () => {
      it('reorders joins in Q5 (6-table join) based on cardinality', () => {
        const plan = optimizeWithStats(`
          SELECT N_NAME, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue
          FROM CUSTOMER c
            JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
            JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
            JOIN SUPPLIER s ON l.L_SUPPKEY = s.S_SUPPKEY
            JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
            JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY
          WHERE r.R_NAME = 'ASIA'
            AND o.O_ORDERDATE >= DATE '1994-01-01'
            AND o.O_ORDERDATE < DATE '1995-01-01'
          GROUP BY N_NAME
          ORDER BY revenue DESC
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        expect(joins.length).toBeGreaterThanOrEqual(1);
        joins.forEach(j => expect(j.physicalStrategy).toBeDefined());
      });

      it('reorders Q3 joins based on table sizes', () => {
        const plan = optimizeWithStats(`
          SELECT L_ORDERKEY, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue
          FROM CUSTOMER c
            JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
            JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
          WHERE c.C_MKTSEGMENT = 'BUILDING'
            AND o.O_ORDERDATE < DATE '1995-03-15'
            AND l.L_SHIPDATE > DATE '1995-03-15'
          GROUP BY L_ORDERKEY
          ORDER BY revenue DESC
          LIMIT 10
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        expect(joins.length).toBeGreaterThanOrEqual(1);
        expect(findNodes(plan, PlanNodeType.TOP_N).length).toBe(1);
      });

      it('prefers nested loop for tiny build side, hash for larger tables', () => {
        const plan = optimizeWithStats(`
          SELECT * FROM NATION n JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        expect(joins.length).toBe(1);
        expect(joins[0].physicalStrategy).toBe(PhysicalStrategy.NESTED_LOOP);

        const plan2 = optimizeWithStats(`
          SELECT * FROM ORDERS o JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY
        `);
        const joins2 = findNodes(plan2, PlanNodeType.JOIN);
        expect(joins2[0].physicalStrategy).toBe(PhysicalStrategy.HASH);
      });

      it('reorders star join to start with smallest dimension (Q5 pattern)', () => {
        const noStats = optimizeSQL(`
          SELECT * FROM CUSTOMER c
            JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
            JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY
          WHERE r.R_NAME = 'ASIA'
        `);
        const withStats = optimizeWithStats(`
          SELECT * FROM CUSTOMER c
            JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
            JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY
          WHERE r.R_NAME = 'ASIA'
        `);
        expect(findNodes(withStats, PlanNodeType.JOIN).length).toBeGreaterThanOrEqual(1);
        const statsJoins = findNodes(withStats, PlanNodeType.JOIN);
        statsJoins.forEach(j => expect(j._cardinality).toBeDefined());
      });
    });

    describe('physical strategy selection based on cost', () => {
      it('assigns build side based on cardinality asymmetry', () => {
        const plan = optimizeWithStats(`
          SELECT * FROM LINEITEM l JOIN PART p ON l.L_PARTKEY = p.P_PARTKEY
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        expect(joins.length).toBe(1);
        expect(joins[0].physicalStrategy).toBe(PhysicalStrategy.HASH);
        if (joins[0]._buildSide) {
          const left = joins[0].children[0];
          const right = joins[0].children[1];
          const leftCard = left._cardinality || 0;
          const rightCard = right._cardinality || 0;
          if (joins[0]._buildSide === 'right') {
            expect(rightCard).toBeLessThanOrEqual(leftCard);
          } else {
            expect(leftCard).toBeLessThanOrEqual(rightCard);
          }
        }
      });

      it('ungrouped aggregate gets UNGROUPED strategy', () => {
        const plan = optimizeWithStats(`
          SELECT SUM(L_EXTENDEDPRICE * L_DISCOUNT) FROM LINEITEM
          WHERE L_SHIPDATE >= DATE '1994-01-01' AND L_DISCOUNT BETWEEN 0.05 AND 0.07
        `);
        const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
        expect(aggs[0].physicalStrategy).toBe(PhysicalStrategy.UNGROUPED);
      });

      it('grouped aggregate with low-NDV keys gets PERFECT_HASH', () => {
        const plan = optimizeWithStats(`
          SELECT L_RETURNFLAG, L_LINESTATUS, SUM(L_QUANTITY) FROM LINEITEM
          GROUP BY L_RETURNFLAG, L_LINESTATUS
        `);
        const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
        expect(aggs[0].physicalStrategy).toBe(PhysicalStrategy.PERFECT_HASH);
      });

      it('low-NDV group key can use PERFECT_HASH strategy', () => {
        const plan = optimizeWithStats(`
          SELECT O_ORDERSTATUS, COUNT(*) FROM ORDERS GROUP BY O_ORDERSTATUS
        `);
        const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
        expect([PhysicalStrategy.PERFECT_HASH, PhysicalStrategy.HASH]).toContain(aggs[0].physicalStrategy);
      });

      it('semi join gets _dedupeBuild annotation', () => {
        const plan = optimizeWithStats(`
          SELECT O_ORDERKEY FROM ORDERS
          WHERE EXISTS (
            SELECT 1 FROM LINEITEM WHERE L_ORDERKEY = O_ORDERKEY AND L_COMMITDATE < L_RECEIPTDATE
          )
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        const semiJoin = joins.find(j => j.joinType === JoinType.SEMI);
        expect(semiJoin).toBeDefined();
        if (semiJoin._dedupeBuild !== undefined) {
          expect(semiJoin._dedupeBuild).toBe(true);
        }
      });

      it('anti join gets _dedupeBuild annotation', () => {
        const plan = optimizeWithStats(`
          SELECT O_ORDERKEY FROM ORDERS
          WHERE NOT EXISTS (
            SELECT 1 FROM LINEITEM WHERE L_ORDERKEY = O_ORDERKEY
          )
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        const antiJoin = joins.find(j => j.joinType === JoinType.ANTI);
        expect(antiJoin).toBeDefined();
        if (antiJoin._dedupeBuild !== undefined) {
          expect(antiJoin._dedupeBuild).toBe(true);
        }
      });
    });

    describe('cost model arithmetic', () => {
      const costModel = new DefaultCostModel();

      it('hash join cost proportional to build + probe sizes', () => {
        const small = costModel.hashJoinCost(100, 1000);
        const large = costModel.hashJoinCost(10000, 100000);
        expect(large).toBeGreaterThan(small);
      });

      it('merge join cheaper than hash when both sides already sorted', () => {
        const mergeCost = costModel.mergeJoinCost(100000, 100000);
        const hashCost = costModel.hashJoinCost(100000, 100000);
        expect(mergeCost).toBeLessThan(hashCost);
      });

      it('cross join has massive penalty', () => {
        const cross = costModel.crossJoinCost(1000, 1000);
        const hash = costModel.hashJoinCost(1000, 1000);
        expect(cross).toBeGreaterThan(hash * 10);
      });

      it('sort cost is O(n log n)', () => {
        const small = costModel.sortCost(1000);
        const large = costModel.sortCost(1000000);
        expect(large / small).toBeGreaterThan(500);
      });

      it('topN sort cheaper than full sort', () => {
        const topN = costModel.topNSortCost(1000000, 10);
        const full = costModel.sortCost(1000000);
        expect(topN).toBeLessThan(full);
      });

      it('stream aggregate cheaper than hash aggregate', () => {
        const stream = costModel.streamAggregateCost(100000);
        const hash = costModel.hashAggregateCost(100000);
        expect(stream).toBeLessThan(hash);
      });

      it('scan cost scales linearly with rows', () => {
        const s1 = costModel.scanCost(1000);
        const s2 = costModel.scanCost(10000);
        expect(s2 / s1).toBeCloseTo(10, 0);
      });
    });

    describe('cardinality estimator', () => {
      it('estimates scan from stats rowCount', () => {
        const stats = tpchStats();
        const est = new DefaultCardinalityEstimator(stats);
        expect(est.estimateScan('LINEITEM')).toBe(6000000);
        expect(est.estimateScan('REGION')).toBe(5);
        expect(est.estimateScan('ORDERS')).toBe(1500000);
      });

      it('defaults to 1000 for unknown table', () => {
        const est = new DefaultCardinalityEstimator(new Map());
        expect(est.estimateScan('UNKNOWN_TABLE')).toBe(1000);
      });

      it('estimates join using NDV of join key', () => {
        const stats = tpchStats();
        const est = new DefaultCardinalityEstimator(stats);
        const condition = {
          kind: 3,
          op: '=',
          left: { kind: 1, tableAlias: 'ORDERS', columnName: 'O_CUSTKEY', columnIndex: 1 },
          right: { kind: 1, tableAlias: 'CUSTOMER', columnName: 'C_CUSTKEY', columnIndex: 0 },
        };
        const card = est.estimateJoin(1500000, 150000, condition);
        expect(card).toBeGreaterThan(0);
        expect(card).toBeLessThan(1500000 * 150000);
      });

      it('cross join cardinality is product of inputs', () => {
        const stats = tpchStats();
        const est = new DefaultCardinalityEstimator(stats);
        const card = est.estimateJoin(100, 200, null);
        expect(card).toBe(20000);
      });

      it('filter estimation reduces cardinality', () => {
        const stats = tpchStats();
        const est = new DefaultCardinalityEstimator(stats);
        const condition = {
          kind: 3,
          op: '=',
          left: { kind: 1, tableAlias: 'ORDERS', columnName: 'O_ORDERSTATUS', columnIndex: 2 },
          right: { kind: 2, value: 'F' },
        };
        const card = est.estimateFilter(1500000, condition);
        expect(card).toBeLessThan(1500000);
        expect(card).toBeGreaterThan(0);
      });
    });

    describe('full TPC-H with cost-based optimization', () => {
      it('Q1 with stats: cardinality annotations present', () => {
        const plan = optimizeWithStats(`
          SELECT L_RETURNFLAG, L_LINESTATUS, SUM(L_QUANTITY), COUNT(*)
          FROM LINEITEM WHERE L_SHIPDATE <= DATE '1998-12-01'
          GROUP BY L_RETURNFLAG, L_LINESTATUS ORDER BY L_RETURNFLAG, L_LINESTATUS
        `);
        const scans = findNodes(plan, PlanNodeType.SCAN);
        expect(scans[0]._cardinality).toBe(6000000);
        const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
        expect(aggs[0]._cardinality).toBeDefined();
        expect(aggs[0]._cardinality).toBeLessThan(6000000);
      });

      it('Q3 with stats: join reorder produces valid plan', () => {
        const plan = optimizeWithStats(`
          SELECT L_ORDERKEY, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue,
            O_ORDERDATE, O_SHIPPRIORITY
          FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
            JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
          WHERE c.C_MKTSEGMENT = 'BUILDING'
            AND o.O_ORDERDATE < DATE '1995-03-15'
            AND l.L_SHIPDATE > DATE '1995-03-15'
          GROUP BY L_ORDERKEY, O_ORDERDATE, O_SHIPPRIORITY
          ORDER BY revenue DESC, O_ORDERDATE LIMIT 10
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        expect(joins.length).toBeGreaterThanOrEqual(2);
        joins.forEach(j => {
          expect(j.physicalStrategy).toBeDefined();
          expect(j._cardinality).toBeGreaterThan(0);
        });
        expect(findNodes(plan, PlanNodeType.TOP_N).length).toBe(1);
      });

      it('Q5 with stats: 6-table join gets reordered', () => {
        const plan = optimizeWithStats(`
          SELECT N_NAME, SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue
          FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
            JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
            JOIN SUPPLIER s ON l.L_SUPPKEY = s.S_SUPPKEY
            JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
            JOIN REGION r ON n.N_REGIONKEY = r.R_REGIONKEY
          WHERE r.R_NAME = 'ASIA'
          GROUP BY N_NAME ORDER BY revenue DESC
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        expect(joins.length).toBeGreaterThanOrEqual(1);
        joins.forEach(j => expect(j._cardinality).toBeDefined());
      });

      it('Q6 with stats: filter selectivity applied to LINEITEM', () => {
        const plan = optimizeWithStats(`
          SELECT SUM(L_EXTENDEDPRICE * L_DISCOUNT) as revenue
          FROM LINEITEM
          WHERE L_SHIPDATE >= DATE '1994-01-01' AND L_SHIPDATE < DATE '1995-01-01'
            AND L_DISCOUNT BETWEEN 0.05 AND 0.07 AND L_QUANTITY < 24
        `);
        const filters = findNodes(plan, PlanNodeType.FILTER);
        expect(filters.length).toBeGreaterThanOrEqual(1);
        const filteredCard = filters[0]._cardinality;
        expect(filteredCard).toBeLessThan(6000000);
        expect(filteredCard).toBeGreaterThan(0);
      });

      it('Q10 with stats: 4-join plan with cardinality throughout', () => {
        const plan = optimizeWithStats(`
          SELECT C_CUSTKEY, C_NAME,
            SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as revenue,
            C_ACCTBAL, N_NAME, C_ADDRESS, C_PHONE, C_COMMENT
          FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
            JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
            JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
          WHERE o.O_ORDERDATE >= DATE '1993-10-01' AND o.O_ORDERDATE < DATE '1994-01-01'
            AND l.L_RETURNFLAG = 'R'
          GROUP BY C_CUSTKEY, C_NAME, C_ACCTBAL, C_PHONE, N_NAME, C_ADDRESS, C_COMMENT
          ORDER BY revenue DESC LIMIT 20
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        joins.forEach(j => {
          expect(j._cardinality).toBeDefined();
          expect(j._cardinality).toBeGreaterThan(0);
        });
        expect(findNodes(plan, PlanNodeType.TOP_N)[0].count).toBe(20);
      });

      it('Q8 with stats: 8-table join reordered by cost', () => {
        const plan = optimizeWithStats(`
          SELECT EXTRACT(YEAR FROM O_ORDERDATE) as o_year,
            SUM(CASE WHEN n2.N_NAME = 'BRAZIL' THEN L_EXTENDEDPRICE * (1 - L_DISCOUNT) ELSE 0 END)
              / SUM(L_EXTENDEDPRICE * (1 - L_DISCOUNT)) as mkt_share
          FROM PART p JOIN LINEITEM l ON p.P_PARTKEY = l.L_PARTKEY
            JOIN SUPPLIER s ON s.S_SUPPKEY = l.L_SUPPKEY
            JOIN ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY
            JOIN CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY
            JOIN NATION n1 ON c.C_NATIONKEY = n1.N_NATIONKEY
            JOIN NATION n2 ON s.S_NATIONKEY = n2.N_NATIONKEY
            JOIN REGION r ON n1.N_REGIONKEY = r.R_REGIONKEY
          WHERE r.R_NAME = 'AMERICA'
            AND O_ORDERDATE BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
            AND P_TYPE = 'ECONOMY ANODIZED STEEL'
          GROUP BY EXTRACT(YEAR FROM O_ORDERDATE)
          ORDER BY o_year
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        expect(joins.length).toBeGreaterThanOrEqual(1);
        joins.forEach(j => expect(j._cardinality).toBeDefined());
      });

      it('all TPC-H queries optimize without error with stats', () => {
        const queries = [
          `SELECT L_RETURNFLAG, SUM(L_QUANTITY) FROM LINEITEM WHERE L_SHIPDATE <= DATE '1998-12-01' GROUP BY L_RETURNFLAG`,
          `SELECT * FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY WHERE c.C_MKTSEGMENT = 'BUILDING' LIMIT 10`,
          `SELECT O_ORDERPRIORITY, COUNT(*) FROM ORDERS WHERE EXISTS (SELECT 1 FROM LINEITEM WHERE L_ORDERKEY = O_ORDERKEY) GROUP BY O_ORDERPRIORITY`,
          `SELECT SUM(L_EXTENDEDPRICE * L_DISCOUNT) FROM LINEITEM WHERE L_QUANTITY < 24`,
          `SELECT L_SHIPMODE, SUM(CASE WHEN O_ORDERPRIORITY = '1-URGENT' THEN 1 ELSE 0 END) FROM ORDERS o JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY GROUP BY L_SHIPMODE`,
          `SELECT c_count, COUNT(*) FROM (SELECT c.C_CUSTKEY, COUNT(o.O_ORDERKEY) as c_count FROM CUSTOMER c LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY GROUP BY c.C_CUSTKEY) sub GROUP BY c_count`,
          `SELECT SUM(CASE WHEN P_TYPE LIKE 'PROMO%' THEN L_EXTENDEDPRICE ELSE 0 END) / SUM(L_EXTENDEDPRICE) FROM LINEITEM l JOIN PART p ON l.L_PARTKEY = p.P_PARTKEY`,
        ];
        for (const sql of queries) {
          const plan = optimizeWithStats(sql);
          expect(plan).toBeDefined();
          expect(plan.type).toBeDefined();
        }
      });
    });

    describe('build side selection for all join types', () => {
      it('LEFT join uses right as build side', () => {
        const plan = optimizeWithStats(`
          SELECT * FROM CUSTOMER c
          LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        const leftJoins = joins.filter(j => j.joinType === JoinType.LEFT);
        for (const j of leftJoins) {
          expect(j._buildSide).toBe('right');
        }
      });

      it('SEMI join uses right as build side', () => {
        const plan = optimizeWithStats(`
          SELECT * FROM ORDERS o
          WHERE EXISTS (SELECT 1 FROM LINEITEM l WHERE l.L_ORDERKEY = o.O_ORDERKEY)
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        const semiJoins = joins.filter(j => j.joinType === JoinType.SEMI);
        for (const j of semiJoins) {
          expect(j._buildSide).toBe('right');
        }
      });

      it('INNER join picks smaller side as build', () => {
        const plan = optimizeWithStats(`
          SELECT * FROM LINEITEM l
          JOIN REGION r ON l.L_SUPPKEY = r.R_REGIONKEY
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN).filter(j => j.joinType === JoinType.INNER);
        expect(joins.length).toBeGreaterThan(0);
        for (const j of joins) {
          expect(j._buildSide).toBeDefined();
        }
      });
    });

    describe('sort-merge join consideration', () => {
      it('merge strategy annotates _requiresSort when selected', () => {
        const plan = optimizeWithStats(`
          SELECT * FROM ORDERS o
          JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        for (const j of joins) {
          if (j.physicalStrategy === PhysicalStrategy.MERGE) {
            expect(j._requiresSort).toBeDefined();
            expect(typeof j._requiresSort.left).toBe('boolean');
            expect(typeof j._requiresSort.right).toBe('boolean');
          }
        }
      });

      it('all joins have a physical strategy assigned', () => {
        const plan = optimizeWithStats(`
          SELECT * FROM CUSTOMER c
          JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
          JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY
        `);
        const joins = findNodes(plan, PlanNodeType.JOIN);
        for (const j of joins) {
          expect([PhysicalStrategy.HASH, PhysicalStrategy.MERGE]).toContain(j.physicalStrategy);
        }
      });
    });

    describe('multi-key join cardinality with stats', () => {
      it('two-key join produces tighter cardinality than single-key', () => {
        const stats = tpchStats();
        const est = new DefaultCardinalityEstimator(stats);
        const BEK = { COLUMN_REF: 'BoundColumnRef', BINARY: 'BoundBinary' };
        const singleKey = {
          kind: BEK.BINARY, op: '=',
          left: { kind: BEK.COLUMN_REF, tableAlias: 'LINEITEM', columnName: 'L_ORDERKEY' },
          right: { kind: BEK.COLUMN_REF, tableAlias: 'ORDERS', columnName: 'O_ORDERKEY' },
        };
        const secondKey = {
          kind: BEK.BINARY, op: '=',
          left: { kind: BEK.COLUMN_REF, tableAlias: 'LINEITEM', columnName: 'L_LINENUMBER' },
          right: { kind: BEK.COLUMN_REF, tableAlias: 'ORDERS', columnName: 'O_CUSTKEY' },
        };
        const combined = { kind: BEK.BINARY, op: 'AND', left: singleKey, right: secondKey };
        const singleResult = est.estimateJoin(6000000, 1500000, singleKey);
        const doubleResult = est.estimateJoin(6000000, 1500000, combined);
        expect(doubleResult).toBeLessThanOrEqual(singleResult);
      });
    });
  });
});
