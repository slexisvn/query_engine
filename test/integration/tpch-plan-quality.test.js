import { describe, it, expect, beforeAll } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { generateTPCHData } from '../fixtures/tpch-gen.js';
import { PlanNodeType, JoinType, PhysicalStrategy, getChildren } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

let engine;

beforeAll(async () => {
  engine = new QueryEngine((await generateTPCHData()).catalog);
});

function collectNodes(node, type) {
  const result = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === type) result.push(n);
    for (const child of getChildren(n)) walk(child);
  })(node);
  return result;
}

function describeExpr(expr, depth = 0) {
  if (!expr || depth > 8) return '';
  if (expr.kind === BoundExprKind.BINARY) {
    return `${describeExpr(expr.left, depth + 1)} ${expr.op} ${describeExpr(expr.right, depth + 1)}`;
  }
  if (expr.kind === BoundExprKind.COLUMN_REF) return `${expr.tableAlias || ''}.${expr.columnName}`;
  if (expr.kind === BoundExprKind.LITERAL) return String(expr.value);
  if (expr.kind === BoundExprKind.AGGREGATE) return `${expr.name}(...)`;
  return expr.kind || '';
}

function expectNoDependentCrossOrJoinFilter(plan) {
  const joins = collectNodes(plan, PlanNodeType.JOIN);
  const filters = collectNodes(plan, PlanNodeType.FILTER);
  expect(collectNodes(plan, PlanNodeType.DEPENDENT_JOIN)).toHaveLength(0);
  expect(joins.filter(j => j.joinType === JoinType.CROSS)).toHaveLength(0);
  expect(filters.filter(f => f.children?.[0]?.type === PlanNodeType.JOIN)).toHaveLength(0);
}

describe('TPC-H plan quality regressions', () => {
  it('fuses Q15 scalar max predicate into join conditions', async () => {
    const { plan } = await engine.compile(`
      WITH revenue AS (
        SELECT l_suppkey AS supplier_no,
          SUM(l_extendedprice * (1 - l_discount)) AS total_revenue
        FROM lineitem
        WHERE l_shipdate >= DATE '1996-01-01' AND l_shipdate < DATE '1996-01-01' + INTERVAL '3' MONTH
        GROUP BY l_suppkey
      )
      SELECT s_suppkey, s_name, s_address, s_phone, total_revenue
      FROM supplier, revenue
      WHERE s_suppkey = supplier_no
        AND total_revenue = (SELECT MAX(total_revenue) FROM revenue)
      ORDER BY s_suppkey
    `);

    expectNoDependentCrossOrJoinFilter(plan);
    const joinText = collectNodes(plan, PlanNodeType.JOIN).map(j => describeExpr(j.condition)).join('\n');
    expect(joinText).toContain('SUPPLIER.S_SUPPKEY = REVENUE.supplier_no');
    expect(joinText).toContain('REVENUE.total_revenue = ._scalar');
  });

  it('optimizes Q15 CTE producer plans before execution', async () => {
    const { cteMap } = await engine.compile(`
      WITH revenue AS (
        SELECT l_suppkey AS supplier_no,
          SUM(l_extendedprice * (1 - l_discount)) AS total_revenue
        FROM lineitem
        WHERE l_shipdate >= DATE '1996-01-01' AND l_shipdate < DATE '1996-01-01' + INTERVAL '3' MONTH
        GROUP BY l_suppkey
      )
      SELECT s_suppkey, s_name, s_address, s_phone, total_revenue
      FROM supplier, revenue
      WHERE s_suppkey = supplier_no
        AND total_revenue = (SELECT MAX(total_revenue) FROM revenue)
      ORDER BY s_suppkey
    `);

    const revenuePlan = cteMap.get('REVENUE');
    expect(revenuePlan).toBeDefined();
    const aggregate = collectNodes(revenuePlan, PlanNodeType.AGGREGATE).find(a =>
      (a.groupBy || []).some(g => g.kind === BoundExprKind.COLUMN_REF && g.columnName === 'L_SUPPKEY')
    );
    expect(aggregate).toBeDefined();
    expect(aggregate.physicalStrategy).toBe(PhysicalStrategy.PERFECT_HASH);
  });

  it('fuses Q20 correlated aggregate threshold into join condition', async () => {
    const { plan } = await engine.compile(`
      SELECT s_name, s_address
      FROM supplier, nation
      WHERE s_suppkey IN (
          SELECT ps_suppkey FROM partsupp
          WHERE ps_partkey IN (
            SELECT p_partkey FROM part WHERE p_name LIKE 'forest%'
          )
          AND ps_availqty > (
            SELECT 0.5 * SUM(l_quantity)
            FROM lineitem
            WHERE l_partkey = ps_partkey AND l_suppkey = ps_suppkey
              AND l_shipdate >= DATE '1994-01-01'
              AND l_shipdate < DATE '1994-01-01' + INTERVAL '1' YEAR
          )
        )
        AND s_nationkey = n_nationkey AND n_name = 'CANADA'
      ORDER BY s_name
    `);

    expectNoDependentCrossOrJoinFilter(plan);
    const joinText = collectNodes(plan, PlanNodeType.JOIN).map(j => describeExpr(j.condition)).join('\n');
    expect(joinText).toContain('PARTSUPP.PS_AVAILQTY > ._scalar');
  });

  it('uses ungrouped aggregate strategy for TPCH scalar aggregates', async () => {
    const queries = [
      `SELECT SUM(l_extendedprice * l_discount) AS revenue FROM lineitem
       WHERE l_shipdate >= DATE '1994-01-01' AND l_shipdate < DATE '1994-01-01' + INTERVAL '1' YEAR`,
      `SELECT 100.00 * SUM(CASE WHEN p_type LIKE 'PROMO%' THEN l_extendedprice ELSE 0 END) / SUM(l_extendedprice) AS promo_revenue
       FROM lineitem, part
       WHERE l_partkey = p_partkey`,
      `SELECT SUM(l_extendedprice * (1 - l_discount)) AS revenue
       FROM lineitem, part
       WHERE p_partkey = l_partkey AND p_brand = 'Brand#12'`,
    ];

    for (const sql of queries) {
      const { plan } = await engine.compile(sql);
      const aggregates = collectNodes(plan, PlanNodeType.AGGREGATE);
      expect(aggregates.length).toBeGreaterThan(0);
      expect(aggregates.every(a => a.physicalStrategy === PhysicalStrategy.UNGROUPED)).toBe(true);
    }
  });

  it('uses perfect hash aggregate for TPCH low-cardinality group keys', async () => {
    const { plan } = await engine.compile(`
      SELECT l_returnflag, l_linestatus,
        SUM(l_quantity) AS sum_qty,
        COUNT(*) AS count_order
      FROM lineitem
      WHERE l_shipdate <= DATE '1998-12-01' - INTERVAL '90' DAY
      GROUP BY l_returnflag, l_linestatus
      ORDER BY l_returnflag, l_linestatus
    `);

    const aggregate = collectNodes(plan, PlanNodeType.AGGREGATE)[0];
    expect(aggregate).toBeDefined();
    expect(aggregate.physicalStrategy).toBe(PhysicalStrategy.PERFECT_HASH);
  });

  it('uses perfect hash aggregate for small derived group keys', async () => {
    const queries = [
      `SELECT c_count, COUNT(*) AS custdist
       FROM (
         SELECT c_custkey, COUNT(o_orderkey) AS c_count
         FROM customer LEFT OUTER JOIN orders ON c_custkey = o_custkey
           AND o_comment NOT LIKE '%special%requests%'
         GROUP BY c_custkey
       ) AS c_orders
       GROUP BY c_count`,
      `SELECT o_year,
         SUM(CASE WHEN nation = 'BRAZIL' THEN volume ELSE 0 END) / SUM(volume) AS mkt_share
       FROM (
         SELECT EXTRACT(YEAR FROM o_orderdate) AS o_year,
           l_extendedprice * (1 - l_discount) AS volume,
           n2.n_name AS nation
         FROM part, supplier, lineitem, orders, customer, nation n1, nation n2, region
         WHERE p_partkey = l_partkey AND s_suppkey = l_suppkey AND l_orderkey = o_orderkey
           AND o_custkey = c_custkey AND c_nationkey = n1.n_nationkey
           AND n1.n_regionkey = r_regionkey AND r_name = 'AMERICA'
           AND s_nationkey = n2.n_nationkey
           AND o_orderdate BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
           AND p_type = 'ECONOMY ANODIZED STEEL'
       ) AS all_nations
       GROUP BY o_year`,
      `SELECT cntrycode, COUNT(*) AS numcust, SUM(c_acctbal) AS totacctbal
       FROM (
         SELECT SUBSTRING(c_phone FROM 1 FOR 2) AS cntrycode, c_acctbal
         FROM customer
         WHERE SUBSTRING(c_phone FROM 1 FOR 2) IN ('13', '31', '23', '29', '30', '18', '17')
       ) AS custsale
       GROUP BY cntrycode`,
    ];

    for (const sql of queries) {
      const { plan } = await engine.compile(sql);
      const aggregates = collectNodes(plan, PlanNodeType.AGGREGATE);
      expect(aggregates.some(a => a.physicalStrategy === PhysicalStrategy.PERFECT_HASH)).toBe(true);
    }
  });

  it('uses perfect hash aggregate for compact integer domains', async () => {
    const { plan } = await engine.compile(`
      SELECT c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice,
        SUM(l_quantity) AS total_qty
      FROM customer, orders, lineitem
      WHERE o_orderkey IN (
          SELECT l_orderkey
          FROM lineitem
          GROUP BY l_orderkey
          HAVING SUM(l_quantity) > 300
        )
        AND c_custkey = o_custkey AND o_orderkey = l_orderkey
      GROUP BY c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice
      ORDER BY o_totalprice DESC, o_orderdate
    `);

    const aggregate = collectNodes(plan, PlanNodeType.AGGREGATE).find(a =>
      (a.groupBy || []).some(g => g.kind === BoundExprKind.COLUMN_REF && g.columnName === 'L_ORDERKEY')
    );
    expect(aggregate).toBeDefined();
    expect(aggregate.physicalStrategy).toBe(PhysicalStrategy.PERFECT_HASH);
  });

  it('pushes Q13 right-side LEFT JOIN predicate into the right input', async () => {
    const { plan } = await engine.compile(`
      SELECT c_count, COUNT(*) AS custdist
      FROM (
        SELECT c_custkey, COUNT(o_orderkey) AS c_count
        FROM customer LEFT OUTER JOIN orders ON c_custkey = o_custkey
          AND o_comment NOT LIKE '%special%requests%'
        GROUP BY c_custkey
      ) AS c_orders
      GROUP BY c_count
      ORDER BY custdist DESC, c_count DESC
    `);

    const leftJoin = collectNodes(plan, PlanNodeType.JOIN).find(j => j.joinType === JoinType.LEFT);
    expect(leftJoin).toBeDefined();
    expect(describeExpr(leftJoin.condition)).toBe('CUSTOMER.C_CUSTKEY = ORDERS.O_CUSTKEY');

    const ordersFilter = collectNodes(leftJoin.children[1], PlanNodeType.FILTER).find(f =>
      f.children?.[0]?.type === PlanNodeType.SCAN && f.children[0].table === 'ORDERS'
    );
    expect(ordersFilter).toBeDefined();
    expect(JSON.stringify(ordersFilter.condition)).toContain('O_COMMENT');
  });

  it('pushes Q7 OR-derived nation filters to both nation scans', async () => {
    const { plan } = await engine.compile(`
      SELECT n1.n_name AS supp_nation, n2.n_name AS cust_nation,
        EXTRACT(YEAR FROM l_shipdate) AS l_year,
        SUM(l_extendedprice * (1 - l_discount)) AS revenue
      FROM supplier, lineitem, orders, customer, nation n1, nation n2
      WHERE s_suppkey = l_suppkey AND o_orderkey = l_orderkey AND c_custkey = o_custkey
        AND s_nationkey = n1.n_nationkey AND c_nationkey = n2.n_nationkey
        AND (
          (n1.n_name = 'FRANCE' AND n2.n_name = 'GERMANY')
          OR (n1.n_name = 'GERMANY' AND n2.n_name = 'FRANCE')
        )
        AND l_shipdate BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
      GROUP BY supp_nation, cust_nation, l_year
    `);

    const filters = collectNodes(plan, PlanNodeType.FILTER);
    const nationScanFilters = filters.filter(f =>
      f.condition.kind === BoundExprKind.IN_LIST
        && f.children?.[0]?.type === PlanNodeType.SCAN
        && ['N1', 'N2'].includes(f.children[0].alias)
    );
    expect(nationScanFilters).toHaveLength(2);
  });

  it('pushes Q19 OR-derived part and lineitem envelopes before the join', async () => {
    const { plan } = await engine.compile(`
      SELECT SUM(l_extendedprice * (1 - l_discount)) AS revenue
      FROM lineitem, part
      WHERE (
          p_partkey = l_partkey AND p_brand = 'Brand#12'
          AND p_container IN ('SM CASE', 'SM BOX', 'SM PACK', 'SM PKG')
          AND l_quantity >= 1 AND l_quantity <= 11
          AND p_size BETWEEN 1 AND 5 AND l_shipmode IN ('AIR', 'AIR REG')
          AND l_shipinstruct = 'DELIVER IN PERSON'
        ) OR (
          p_partkey = l_partkey AND p_brand = 'Brand#23'
          AND p_container IN ('MED BAG', 'MED BOX', 'MED PKG', 'MED PACK')
          AND l_quantity >= 10 AND l_quantity <= 20
          AND p_size BETWEEN 1 AND 10 AND l_shipmode IN ('AIR', 'AIR REG')
          AND l_shipinstruct = 'DELIVER IN PERSON'
        ) OR (
          p_partkey = l_partkey AND p_brand = 'Brand#34'
          AND p_container IN ('LG CASE', 'LG BOX', 'LG PACK', 'LG PKG')
          AND l_quantity >= 20 AND l_quantity <= 30
          AND p_size BETWEEN 1 AND 15 AND l_shipmode IN ('AIR', 'AIR REG')
          AND l_shipinstruct = 'DELIVER IN PERSON'
        )
    `);

    const filters = collectNodes(plan, PlanNodeType.FILTER);
    const partFilter = filters.find(f => f.children?.[0]?.type === PlanNodeType.SCAN && f.children[0].table === 'PART');
    const lineitemFilter = filters.find(f => f.children?.[0]?.type === PlanNodeType.SCAN && f.children[0].table === 'LINEITEM');
    expect(JSON.stringify(partFilter?.condition)).toContain('P_CONTAINER');
    expect(JSON.stringify(partFilter?.condition)).toContain('P_SIZE');
    expect(JSON.stringify(lineitemFilter?.condition)).toContain('L_QUANTITY');

    const residualFilter = filters.find(f =>
      f.children?.[0]?.type === PlanNodeType.JOIN
        && f.condition.kind === BoundExprKind.BINARY
        && f.condition.op === 'OR'
    );
    const join = collectNodes(plan, PlanNodeType.JOIN)[0];
    expect(residualFilter).toBeDefined();
    expect(describeExpr(join.condition)).toBe('PART.P_PARTKEY = LINEITEM.L_PARTKEY');
  });

  it('uses nested-loop strategy for TPCH scalar inequality joins', async () => {
    const queries = [
      `SELECT ps_partkey, SUM(ps_supplycost * ps_availqty) AS value
       FROM partsupp, supplier, nation
       WHERE ps_suppkey = s_suppkey AND s_nationkey = n_nationkey AND n_name = 'GERMANY'
       GROUP BY ps_partkey
       HAVING SUM(ps_supplycost * ps_availqty) > (
         SELECT SUM(ps_supplycost * ps_availqty) * 0.0001
         FROM partsupp, supplier, nation
         WHERE ps_suppkey = s_suppkey AND s_nationkey = n_nationkey AND n_name = 'GERMANY'
       )`,
      `SELECT cntrycode, COUNT(*) AS numcust, SUM(c_acctbal) AS totacctbal
       FROM (
         SELECT SUBSTRING(c_phone FROM 1 FOR 2) AS cntrycode, c_acctbal
         FROM customer
         WHERE SUBSTRING(c_phone FROM 1 FOR 2) IN ('13', '31', '23', '29', '30', '18', '17')
           AND c_acctbal > (
             SELECT AVG(c_acctbal) FROM customer
             WHERE c_acctbal > 0
               AND SUBSTRING(c_phone FROM 1 FOR 2) IN ('13', '31', '23', '29', '30', '18', '17')
           )
           AND NOT EXISTS (
             SELECT * FROM orders WHERE o_custkey = c_custkey
           )
       ) AS custsale
       GROUP BY cntrycode`,
    ];

    for (const sql of queries) {
      const { plan } = await engine.compile(sql);
      const joins = collectNodes(plan, PlanNodeType.JOIN);
      expect(joins.some(j => j.physicalStrategy === PhysicalStrategy.NESTED_LOOP)).toBe(true);
    }
  });

  it('removes duplicate scalar projection layers in TPCH Q11', async () => {
    const { plan } = await engine.compile(`
      SELECT ps_partkey, SUM(ps_supplycost * ps_availqty) AS value
      FROM partsupp, supplier, nation
      WHERE ps_suppkey = s_suppkey AND s_nationkey = n_nationkey AND n_name = 'GERMANY'
      GROUP BY ps_partkey
      HAVING SUM(ps_supplycost * ps_availqty) > (
        SELECT SUM(ps_supplycost * ps_availqty) * 0.0001
        FROM partsupp, supplier, nation
        WHERE ps_suppkey = s_suppkey AND s_nationkey = n_nationkey AND n_name = 'GERMANY'
      )
      ORDER BY value DESC
    `);

    const nestedProjects = collectNodes(plan, PlanNodeType.PROJECT).filter(p =>
      p.children?.[0]?.type === PlanNodeType.PROJECT
    );
    expect(nestedProjects).toHaveLength(0);
  });

  it('uses MARK join for TPCH Q16 NOT IN without blocking outer predicate pushdown', async () => {
    const { plan } = await engine.compile(`
      SELECT p_brand, p_type, p_size, COUNT(DISTINCT ps_suppkey) AS supplier_cnt
      FROM partsupp, part
      WHERE p_partkey = ps_partkey AND p_brand <> 'Brand#45'
        AND p_type NOT LIKE 'MEDIUM POLISHED%'
        AND p_size IN (49, 14, 23, 45, 19, 3, 36, 9)
        AND ps_suppkey NOT IN (
          SELECT s_suppkey FROM supplier WHERE s_comment LIKE '%Customer%Complaints%'
        )
      GROUP BY p_brand, p_type, p_size
    `);

    const joins = collectNodes(plan, PlanNodeType.JOIN);
    const markJoin = joins.find(j => j.joinType === JoinType.MARK);
    expect(markJoin).toBeDefined();
    expect(markJoin.physicalStrategy).toBe(PhysicalStrategy.HASH);
    expect(markJoin._dedupeBuild).toBe(true);
    expect(joins.filter(j => j.joinType === JoinType.CROSS)).toHaveLength(0);
    expect(collectNodes(markJoin.children[0], PlanNodeType.JOIN).some(j =>
      describeExpr(j.condition).includes('PART.P_PARTKEY = PARTSUPP.PS_PARTKEY')
    )).toBe(true);
  });

  it('keeps Q17 scalar aggregate column pruning local to the subquery branch', async () => {
    const { plan } = await engine.compile(`
      SELECT SUM(l_extendedprice) / 7.0 AS avg_yearly
      FROM lineitem, part
      WHERE p_partkey = l_partkey AND p_brand = 'Brand#23'
        AND p_container = 'MED BOX'
        AND l_quantity < (
          SELECT 0.2 * AVG(l_quantity)
          FROM lineitem
          WHERE l_partkey = p_partkey
        )
    `);

    const aggregate = collectNodes(plan, PlanNodeType.AGGREGATE).find(a =>
      (a.groupBy || []).some(g => g.kind === BoundExprKind.COLUMN_REF && g.columnName === 'L_PARTKEY')
    );
    expect(aggregate).toBeDefined();
    expect(aggregate.physicalStrategy).toBe(PhysicalStrategy.PERFECT_HASH);

    const scans = collectNodes(aggregate, PlanNodeType.SCAN).filter(s => s.table === 'LINEITEM');
    expect(scans).toHaveLength(1);
    expect(scans[0].columns.map(c => c.name)).toEqual(['L_PARTKEY', 'L_QUANTITY']);
  });

  it('keeps projected subquery columns required through relation aliases', async () => {
    const queries = [
      {
        sql: `
          SELECT o_year,
            SUM(CASE WHEN nation = 'BRAZIL' THEN volume ELSE 0 END) / SUM(volume) AS mkt_share
          FROM (
            SELECT EXTRACT(YEAR FROM o_orderdate) AS o_year,
              l_extendedprice * (1 - l_discount) AS volume,
              n2.n_name AS nation
            FROM part, supplier, lineitem, orders, customer, nation n1, nation n2, region
            WHERE p_partkey = l_partkey AND s_suppkey = l_suppkey AND l_orderkey = o_orderkey
              AND o_custkey = c_custkey AND c_nationkey = n1.n_nationkey
              AND n1.n_regionkey = r_regionkey AND r_name = 'AMERICA'
              AND s_nationkey = n2.n_nationkey
              AND o_orderdate BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
              AND p_type = 'ECONOMY ANODIZED STEEL'
          ) AS all_nations
          GROUP BY o_year
        `,
        scan: 'N2',
        column: 'N_NAME',
      },
      {
        sql: `
          SELECT nation, o_year, SUM(amount) AS sum_profit
          FROM (
            SELECT n_name AS nation,
              EXTRACT(YEAR FROM o_orderdate) AS o_year,
              l_extendedprice * (1 - l_discount) - ps_supplycost * l_quantity AS amount
            FROM part, supplier, lineitem, partsupp, orders, nation
            WHERE s_suppkey = l_suppkey AND ps_suppkey = l_suppkey AND ps_partkey = l_partkey
              AND p_partkey = l_partkey AND o_orderkey = l_orderkey AND s_nationkey = n_nationkey
              AND p_name LIKE '%green%'
          ) AS profit
          GROUP BY nation, o_year
        `,
        scan: 'NATION',
        column: 'N_NAME',
      },
    ];

    for (const { sql, scan, column } of queries) {
      const { plan } = await engine.compile(sql);
      const nationScan = collectNodes(plan, PlanNodeType.SCAN).find(s => s.alias === scan);
      expect(nationScan).toBeDefined();
      expect(nationScan.columns.map(c => c.name)).toContain(column);
    }
  });

  it('deduplicates build keys for TPCH semi and anti existence joins', async () => {
    const queries = [
      `SELECT o_orderpriority, COUNT(*) AS order_count
       FROM orders
       WHERE o_orderdate >= DATE '1993-07-01' AND o_orderdate < DATE '1993-07-01' + INTERVAL '3' MONTH
         AND EXISTS (
           SELECT * FROM lineitem WHERE l_orderkey = o_orderkey AND l_commitdate < l_receiptdate
         )
       GROUP BY o_orderpriority`,
      `SELECT c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice,
         SUM(l_quantity) AS total_qty
       FROM customer, orders, lineitem
       WHERE o_orderkey IN (
           SELECT l_orderkey FROM lineitem GROUP BY l_orderkey HAVING SUM(l_quantity) > 300
         )
         AND c_custkey = o_custkey AND o_orderkey = l_orderkey
       GROUP BY c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice`,
      `SELECT cntrycode, COUNT(*) AS numcust, SUM(c_acctbal) AS totacctbal
       FROM (
         SELECT SUBSTRING(c_phone FROM 1 FOR 2) AS cntrycode, c_acctbal
         FROM customer
         WHERE NOT EXISTS (
           SELECT * FROM orders WHERE o_custkey = c_custkey
         )
       ) AS custsale
       GROUP BY cntrycode`,
    ];

    for (const sql of queries) {
      const { plan } = await engine.compile(sql);
      const joins = collectNodes(plan, PlanNodeType.JOIN)
        .filter(j => j.joinType === JoinType.SEMI || j.joinType === JoinType.ANTI);
      expect(joins.length).toBeGreaterThan(0);
      expect(joins.some(j => j._dedupeBuild)).toBe(true);
    }
  });
});
