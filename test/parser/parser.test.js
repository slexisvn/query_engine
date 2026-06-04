import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/parser.js';
import { NodeKind } from '../../src/parser/ast.js';

describe('Parser', () => {
  it('parses simple SELECT', () => {
    const ast = parse("SELECT 1");
    expect(ast.kind).toBe(NodeKind.SELECT_STMT);
    expect(ast.selectItems).toHaveLength(1);
    expect(ast.selectItems[0].expr.value).toBe(1);
  });

  it('parses SELECT with alias', () => {
    const ast = parse("SELECT 1 AS x");
    expect(ast.selectItems[0].alias).toBe('x');
  });

  it('parses SELECT *', () => {
    const ast = parse("SELECT * FROM t");
    expect(ast.selectItems[0].expr.kind).toBe(NodeKind.ALL_COLUMNS);
  });

  it('parses table.* in SELECT', () => {
    const ast = parse("SELECT t.* FROM t");
    expect(ast.selectItems[0].expr.kind).toBe(NodeKind.ALL_COLUMNS);
    expect(ast.selectItems[0].expr.table).toBe('t');
  });

  it('parses column reference with table qualifier', () => {
    const ast = parse("SELECT t.col FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.COLUMN_REF);
    expect(expr.table).toBe('t');
    expect(expr.name).toBe('col');
  });

  it('parses JOIN', () => {
    const ast = parse("SELECT * FROM a INNER JOIN b ON a.id = b.id");
    expect(ast.from.kind).toBe(NodeKind.JOIN_REF);
    expect(ast.from.joinType).toBe('INNER');
  });

  it('parses LEFT OUTER JOIN', () => {
    const ast = parse("SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id");
    expect(ast.from.joinType).toBe('LEFT');
  });

  it('parses WHERE clause', () => {
    const ast = parse("SELECT * FROM t WHERE x > 5");
    expect(ast.where.kind).toBe(NodeKind.BINARY_EXPR);
    expect(ast.where.op).toBe('>');
  });

  it('parses GROUP BY and HAVING', () => {
    const ast = parse("SELECT col, COUNT(*) FROM t GROUP BY col HAVING COUNT(*) > 1");
    expect(ast.groupBy).toHaveLength(1);
    expect(ast.having.kind).toBe(NodeKind.BINARY_EXPR);
  });

  it('parses ORDER BY with direction', () => {
    const ast = parse("SELECT * FROM t ORDER BY a DESC, b ASC");
    expect(ast.orderBy).toHaveLength(2);
    expect(ast.orderBy[0].direction).toBe('DESC');
    expect(ast.orderBy[1].direction).toBe('ASC');
  });

  it('parses LIMIT', () => {
    const ast = parse("SELECT * FROM t LIMIT 10");
    expect(ast.limit.value).toBe(10);
  });

  it('parses BETWEEN', () => {
    const ast = parse("SELECT * FROM t WHERE x BETWEEN 1 AND 10");
    expect(ast.where.kind).toBe(NodeKind.BETWEEN_EXPR);
    expect(ast.where.negated).toBe(false);
  });

  it('parses NOT BETWEEN', () => {
    const ast = parse("SELECT * FROM t WHERE x NOT BETWEEN 1 AND 10");
    expect(ast.where.negated).toBe(true);
  });

  it('parses IN list', () => {
    const ast = parse("SELECT * FROM t WHERE x IN (1, 2, 3)");
    expect(ast.where.kind).toBe(NodeKind.IN_EXPR);
    expect(ast.where.list).toHaveLength(3);
  });

  it('parses IN subquery', () => {
    const ast = parse("SELECT * FROM t WHERE x IN (SELECT id FROM s)");
    expect(ast.where.kind).toBe(NodeKind.IN_EXPR);
    expect(ast.where.list.kind).toBe(NodeKind.SUBQUERY_EXPR);
  });

  it('parses NOT IN subquery', () => {
    const ast = parse("SELECT * FROM t WHERE x NOT IN (SELECT id FROM s)");
    expect(ast.where.negated).toBe(true);
  });

  it('parses EXISTS', () => {
    const ast = parse("SELECT * FROM t WHERE EXISTS (SELECT 1 FROM s WHERE s.id = t.id)");
    expect(ast.where.kind).toBe(NodeKind.EXISTS_EXPR);
  });

  it('parses LIKE', () => {
    const ast = parse("SELECT * FROM t WHERE name LIKE '%foo%'");
    expect(ast.where.kind).toBe(NodeKind.LIKE_EXPR);
  });

  it('parses IS NULL and IS NOT NULL', () => {
    const ast = parse("SELECT * FROM t WHERE x IS NULL");
    expect(ast.where.kind).toBe(NodeKind.IS_NULL_EXPR);
    expect(ast.where.negated).toBe(false);

    const ast2 = parse("SELECT * FROM t WHERE x IS NOT NULL");
    expect(ast2.where.negated).toBe(true);
  });

  it('parses CASE expression', () => {
    const ast = parse("SELECT CASE WHEN x > 0 THEN 'pos' ELSE 'neg' END FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.CASE_EXPR);
    expect(expr.whenClauses).toHaveLength(1);
    expect(expr.elseExpr.value).toBe('neg');
  });

  it('parses CAST', () => {
    const ast = parse("SELECT CAST(x AS INTEGER) FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.CAST_EXPR);
    expect(expr.targetType.name).toBe('INTEGER');
  });

  it('parses EXTRACT', () => {
    const ast = parse("SELECT EXTRACT(YEAR FROM d) FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.EXTRACT_EXPR);
    expect(expr.field).toBe('YEAR');
  });

  it('parses SUBSTRING', () => {
    const ast = parse("SELECT SUBSTRING(name FROM 1 FOR 3) FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.SUBSTRING_EXPR);
  });

  it('parses INTERVAL', () => {
    const ast = parse("SELECT d + INTERVAL '1' YEAR FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.BINARY_EXPR);
    expect(expr.right.kind).toBe(NodeKind.INTERVAL_EXPR);
    expect(expr.right.unit).toBe('YEAR');
  });

  it('parses COUNT(*)', () => {
    const ast = parse("SELECT COUNT(*) FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.AGGREGATE_CALL);
    expect(expr.name).toBe('COUNT_STAR');
  });

  it('parses COUNT(DISTINCT x)', () => {
    const ast = parse("SELECT COUNT(DISTINCT x) FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.AGGREGATE_CALL);
    expect(expr.name).toBe('COUNT');
    expect(expr.distinct).toBe(true);
  });

  it('parses SUM aggregate', () => {
    const ast = parse("SELECT SUM(x) FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.AGGREGATE_CALL);
    expect(expr.name).toBe('SUM');
  });

  it('parses WITH (CTE)', () => {
    const ast = parse("WITH cte AS (SELECT 1 AS x) SELECT * FROM cte");
    expect(ast.withClause.kind).toBe(NodeKind.WITH_CLAUSE);
    expect(ast.withClause.ctes).toHaveLength(1);
    expect(ast.withClause.ctes[0].name).toBe('cte');
  });

  it('parses UNION ALL', () => {
    const ast = parse("SELECT 1 UNION ALL SELECT 2");
    expect(ast.kind).toBe(NodeKind.SET_OP);
    expect(ast.op).toBe('UNION');
    expect(ast.all).toBe(true);
  });

  it('parses subquery in FROM', () => {
    const ast = parse("SELECT * FROM (SELECT 1 AS x) AS sub");
    expect(ast.from.kind).toBe(NodeKind.SUBQUERY_REF);
    expect(ast.from.alias).toBe('sub');
  });

  it('parses DATE literal', () => {
    const ast = parse("SELECT * FROM t WHERE d > DATE '1995-01-01'");
    expect(ast.where.right.value).toBe('1995-01-01');
    expect(ast.where.right.dataType).toBe('DATE');
  });

  it('parses multiple JOINs', () => {
    const ast = parse("SELECT * FROM a JOIN b ON a.id = b.aid JOIN c ON b.id = c.bid");
    expect(ast.from.kind).toBe(NodeKind.JOIN_REF);
    expect(ast.from.left.kind).toBe(NodeKind.JOIN_REF);
  });

  it('parses arithmetic expressions', () => {
    const ast = parse("SELECT a * (1 - b) FROM t");
    const expr = ast.selectItems[0].expr;
    expect(expr.kind).toBe(NodeKind.BINARY_EXPR);
    expect(expr.op).toBe('*');
  });

  it('parses nested subquery in WHERE', () => {
    const ast = parse(`
      SELECT * FROM t WHERE x = (SELECT MAX(y) FROM s WHERE s.id = t.id)
    `);
    expect(ast.where.right.kind).toBe(NodeKind.SUBQUERY_EXPR);
  });
});

describe('Parser - TPC-H Queries', () => {
  const tpchQueries = getTpchQueries();

  for (const [name, sql] of Object.entries(tpchQueries)) {
    it(`parses ${name}`, () => {
      const ast = parse(sql);
      expect(ast).toBeDefined();
      expect(ast.kind === NodeKind.SELECT_STMT || ast.kind === NodeKind.SET_OP).toBe(true);
    });
  }
});

function getTpchQueries() {
  return {
    Q1: `
      SELECT
        l_returnflag, l_linestatus,
        SUM(l_quantity) AS sum_qty,
        SUM(l_extendedprice) AS sum_base_price,
        SUM(l_extendedprice * (1 - l_discount)) AS sum_disc_price,
        SUM(l_extendedprice * (1 - l_discount) * (1 + l_tax)) AS sum_charge,
        AVG(l_quantity) AS avg_qty,
        AVG(l_extendedprice) AS avg_price,
        AVG(l_discount) AS avg_disc,
        COUNT(*) AS count_order
      FROM lineitem
      WHERE l_shipdate <= DATE '1998-12-01' - INTERVAL '90' DAY
      GROUP BY l_returnflag, l_linestatus
      ORDER BY l_returnflag, l_linestatus
    `,
    Q2: `
      SELECT s_acctbal, s_name, n_name, p_partkey, p_mfgr, s_address, s_phone, s_comment
      FROM part, supplier, partsupp, nation, region
      WHERE p_partkey = ps_partkey AND s_suppkey = ps_suppkey AND p_size = 15
        AND p_type LIKE '%BRASS' AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey
        AND r_name = 'EUROPE'
        AND ps_supplycost = (
          SELECT MIN(ps_supplycost)
          FROM partsupp, supplier, nation, region
          WHERE p_partkey = ps_partkey AND s_suppkey = ps_suppkey
            AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey AND r_name = 'EUROPE'
        )
      ORDER BY s_acctbal DESC, n_name, s_name, p_partkey
      LIMIT 100
    `,
    Q3: `
      SELECT l_orderkey, SUM(l_extendedprice * (1 - l_discount)) AS revenue, o_orderdate, o_shippriority
      FROM customer, orders, lineitem
      WHERE c_mktsegment = 'BUILDING' AND c_custkey = o_custkey AND l_orderkey = o_orderkey
        AND o_orderdate < DATE '1995-03-15' AND l_shipdate > DATE '1995-03-15'
      GROUP BY l_orderkey, o_orderdate, o_shippriority
      ORDER BY revenue DESC, o_orderdate
      LIMIT 10
    `,
    Q4: `
      SELECT o_orderpriority, COUNT(*) AS order_count
      FROM orders
      WHERE o_orderdate >= DATE '1993-07-01' AND o_orderdate < DATE '1993-07-01' + INTERVAL '3' MONTH
        AND EXISTS (
          SELECT * FROM lineitem WHERE l_orderkey = o_orderkey AND l_commitdate < l_receiptdate
        )
      GROUP BY o_orderpriority
      ORDER BY o_orderpriority
    `,
    Q5: `
      SELECT n_name, SUM(l_extendedprice * (1 - l_discount)) AS revenue
      FROM customer, orders, lineitem, supplier, nation, region
      WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey AND l_suppkey = s_suppkey
        AND c_nationkey = s_nationkey AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey
        AND r_name = 'ASIA' AND o_orderdate >= DATE '1994-01-01'
        AND o_orderdate < DATE '1994-01-01' + INTERVAL '1' YEAR
      GROUP BY n_name
      ORDER BY revenue DESC
    `,
    Q6: `
      SELECT SUM(l_extendedprice * l_discount) AS revenue
      FROM lineitem
      WHERE l_shipdate >= DATE '1994-01-01' AND l_shipdate < DATE '1994-01-01' + INTERVAL '1' YEAR
        AND l_discount BETWEEN 0.06 - 0.01 AND 0.06 + 0.01 AND l_quantity < 24
    `,
    Q7: `
      SELECT supp_nation, cust_nation, l_year, SUM(volume) AS revenue
      FROM (
        SELECT n1.n_name AS supp_nation, n2.n_name AS cust_nation,
          EXTRACT(YEAR FROM l_shipdate) AS l_year,
          l_extendedprice * (1 - l_discount) AS volume
        FROM supplier, lineitem, orders, customer, nation n1, nation n2
        WHERE s_suppkey = l_suppkey AND o_orderkey = l_orderkey AND c_custkey = o_custkey
          AND s_nationkey = n1.n_nationkey AND c_nationkey = n2.n_nationkey
          AND ((n1.n_name = 'FRANCE' AND n2.n_name = 'GERMANY')
            OR (n1.n_name = 'GERMANY' AND n2.n_name = 'FRANCE'))
          AND l_shipdate BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
      ) AS shipping
      GROUP BY supp_nation, cust_nation, l_year
      ORDER BY supp_nation, cust_nation, l_year
    `,
    Q8: `
      SELECT o_year, SUM(CASE WHEN nation = 'BRAZIL' THEN volume ELSE 0 END) / SUM(volume) AS mkt_share
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
      ORDER BY o_year
    `,
    Q9: `
      SELECT nation, o_year, SUM(amount) AS sum_profit
      FROM (
        SELECT n_name AS nation, EXTRACT(YEAR FROM o_orderdate) AS o_year,
          l_extendedprice * (1 - l_discount) - ps_supplycost * l_quantity AS amount
        FROM part, supplier, lineitem, partsupp, orders, nation
        WHERE s_suppkey = l_suppkey AND ps_suppkey = l_suppkey AND ps_partkey = l_partkey
          AND p_partkey = l_partkey AND o_orderkey = l_orderkey AND s_nationkey = n_nationkey
          AND p_name LIKE '%green%'
      ) AS profit
      GROUP BY nation, o_year
      ORDER BY nation, o_year DESC
    `,
    Q10: `
      SELECT c_custkey, c_name, SUM(l_extendedprice * (1 - l_discount)) AS revenue,
        c_acctbal, n_name, c_address, c_phone, c_comment
      FROM customer, orders, lineitem, nation
      WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey
        AND o_orderdate >= DATE '1993-10-01' AND o_orderdate < DATE '1993-10-01' + INTERVAL '3' MONTH
        AND l_returnflag = 'R' AND c_nationkey = n_nationkey
      GROUP BY c_custkey, c_name, c_acctbal, c_phone, n_name, c_address, c_comment
      ORDER BY revenue DESC
      LIMIT 20
    `,
    Q11: `
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
    `,
    Q12: `
      SELECT l_shipmode,
        SUM(CASE WHEN o_orderpriority = '1-URGENT' OR o_orderpriority = '2-HIGH' THEN 1 ELSE 0 END) AS high_line_count,
        SUM(CASE WHEN o_orderpriority <> '1-URGENT' AND o_orderpriority <> '2-HIGH' THEN 1 ELSE 0 END) AS low_line_count
      FROM orders, lineitem
      WHERE o_orderkey = l_orderkey AND l_shipmode IN ('MAIL', 'SHIP')
        AND l_commitdate < l_receiptdate AND l_shipdate < l_commitdate
        AND l_receiptdate >= DATE '1994-01-01' AND l_receiptdate < DATE '1994-01-01' + INTERVAL '1' YEAR
      GROUP BY l_shipmode
      ORDER BY l_shipmode
    `,
    Q13: `
      SELECT c_count, COUNT(*) AS custdist
      FROM (
        SELECT c_custkey, COUNT(o_orderkey) AS c_count
        FROM customer LEFT OUTER JOIN orders ON c_custkey = o_custkey AND o_comment NOT LIKE '%special%requests%'
        GROUP BY c_custkey
      ) AS c_orders
      GROUP BY c_count
      ORDER BY custdist DESC, c_count DESC
    `,
    Q14: `
      SELECT 100.00 * SUM(CASE WHEN p_type LIKE 'PROMO%' THEN l_extendedprice * (1 - l_discount) ELSE 0 END)
        / SUM(l_extendedprice * (1 - l_discount)) AS promo_revenue
      FROM lineitem, part
      WHERE l_partkey = p_partkey AND l_shipdate >= DATE '1995-09-01'
        AND l_shipdate < DATE '1995-09-01' + INTERVAL '1' MONTH
    `,
    Q15: `
      WITH revenue AS (
        SELECT l_suppkey AS supplier_no, SUM(l_extendedprice * (1 - l_discount)) AS total_revenue
        FROM lineitem
        WHERE l_shipdate >= DATE '1996-01-01' AND l_shipdate < DATE '1996-01-01' + INTERVAL '3' MONTH
        GROUP BY l_suppkey
      )
      SELECT s_suppkey, s_name, s_address, s_phone, total_revenue
      FROM supplier, revenue
      WHERE s_suppkey = supplier_no
        AND total_revenue = (SELECT MAX(total_revenue) FROM revenue)
      ORDER BY s_suppkey
    `,
    Q16: `
      SELECT p_brand, p_type, p_size, COUNT(DISTINCT ps_suppkey) AS supplier_cnt
      FROM partsupp, part
      WHERE p_partkey = ps_partkey AND p_brand <> 'Brand#45'
        AND p_type NOT LIKE 'MEDIUM POLISHED%'
        AND p_size IN (49, 14, 23, 45, 19, 3, 36, 9)
        AND ps_suppkey NOT IN (
          SELECT s_suppkey FROM supplier WHERE s_comment LIKE '%Customer%Complaints%'
        )
      GROUP BY p_brand, p_type, p_size
      ORDER BY supplier_cnt DESC, p_brand, p_type, p_size
    `,
    Q17: `
      SELECT SUM(l_extendedprice) / 7.0 AS avg_yearly
      FROM lineitem, part
      WHERE p_partkey = l_partkey AND p_brand = 'Brand#23' AND p_container = 'MED BOX'
        AND l_quantity < (
          SELECT 0.2 * AVG(l_quantity)
          FROM lineitem
          WHERE l_partkey = p_partkey
        )
    `,
    Q18: `
      SELECT c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice, SUM(l_quantity)
      FROM customer, orders, lineitem
      WHERE o_orderkey IN (
          SELECT l_orderkey FROM lineitem GROUP BY l_orderkey HAVING SUM(l_quantity) > 300
        )
        AND c_custkey = o_custkey AND o_orderkey = l_orderkey
      GROUP BY c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice
      ORDER BY o_totalprice DESC, o_orderdate
      LIMIT 100
    `,
    Q19: `
      SELECT SUM(l_extendedprice * (1 - l_discount)) AS revenue
      FROM lineitem, part
      WHERE (
          p_partkey = l_partkey AND p_brand = 'Brand#12'
          AND p_container IN ('SM CASE', 'SM BOX', 'SM PACK', 'SM PKG')
          AND l_quantity >= 1 AND l_quantity <= 1 + 10
          AND p_size BETWEEN 1 AND 5 AND l_shipmode IN ('AIR', 'AIR REG') AND l_shipinstruct = 'DELIVER IN PERSON'
        ) OR (
          p_partkey = l_partkey AND p_brand = 'Brand#23'
          AND p_container IN ('MED BAG', 'MED BOX', 'MED PKG', 'MED PACK')
          AND l_quantity >= 10 AND l_quantity <= 10 + 10
          AND p_size BETWEEN 1 AND 10 AND l_shipmode IN ('AIR', 'AIR REG') AND l_shipinstruct = 'DELIVER IN PERSON'
        ) OR (
          p_partkey = l_partkey AND p_brand = 'Brand#34'
          AND p_container IN ('LG CASE', 'LG BOX', 'LG PACK', 'LG PKG')
          AND l_quantity >= 20 AND l_quantity <= 20 + 10
          AND p_size BETWEEN 1 AND 15 AND l_shipmode IN ('AIR', 'AIR REG') AND l_shipinstruct = 'DELIVER IN PERSON'
        )
    `,
    Q20: `
      SELECT s_name, s_address
      FROM supplier, nation
      WHERE s_suppkey IN (
          SELECT ps_suppkey FROM partsupp
          WHERE ps_partkey IN (SELECT p_partkey FROM part WHERE p_name LIKE 'forest%')
            AND ps_availqty > (
              SELECT 0.5 * SUM(l_quantity)
              FROM lineitem
              WHERE l_partkey = ps_partkey AND l_suppkey = ps_suppkey
                AND l_shipdate >= DATE '1994-01-01' AND l_shipdate < DATE '1994-01-01' + INTERVAL '1' YEAR
            )
        )
        AND s_nationkey = n_nationkey AND n_name = 'CANADA'
      ORDER BY s_name
    `,
    Q21: `
      SELECT s_name, COUNT(*) AS numwait
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
      LIMIT 100
    `,
    Q22: `
      SELECT cntrycode, COUNT(*) AS numcust, SUM(c_acctbal) AS totacctbal
      FROM (
        SELECT SUBSTRING(c_phone FROM 1 FOR 2) AS cntrycode, c_acctbal
        FROM customer
        WHERE SUBSTRING(c_phone FROM 1 FOR 2) IN ('13', '31', '23', '29', '30', '18', '17')
          AND c_acctbal > (
            SELECT AVG(c_acctbal) FROM customer
            WHERE c_acctbal > 0.00
              AND SUBSTRING(c_phone FROM 1 FOR 2) IN ('13', '31', '23', '29', '30', '18', '17')
          )
          AND NOT EXISTS (SELECT * FROM orders WHERE o_custkey = c_custkey)
      ) AS custsale
      GROUP BY cntrycode
      ORDER BY cntrycode
    `,
  };
}
