import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/parser.js';
import { Binder } from '../../src/binder/binder.js';
import { createTPCHCatalog } from '../../src/catalog/tpch-schema.js';
import { defaultFunctionRegistry } from '../../src/catalog/function-registry.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { createLogicalPlan } from '../../src/planner/logical-planner.js';
import { PlanNodeType } from '../../src/planner/logical-plan.js';

function bind(sql) {
  const catalog = createTPCHCatalog();
  const binder = new Binder(catalog, defaultFunctionRegistry);
  const ast = parse(sql);
  return binder.bind(ast);
}

function plan(sql) {
  const bound = bind(sql);
  return createLogicalPlan(bound);
}

describe('Binder', () => {
  it('resolves simple column references', () => {
    const bound = bind("SELECT r_regionkey FROM region");
    expect(bound.selectItems[0].expr.kind).toBe(BoundExprKind.COLUMN_REF);
    expect(bound.selectItems[0].expr.columnName).toBe('R_REGIONKEY');
  });

  it('resolves qualified column references', () => {
    const bound = bind("SELECT r.r_regionkey FROM region r");
    expect(bound.selectItems[0].expr.kind).toBe(BoundExprKind.COLUMN_REF);
    expect(bound.selectItems[0].expr.tableAlias).toBe('R');
  });

  it('expands star', () => {
    const bound = bind("SELECT * FROM region");
    expect(bound.selectItems.length).toBe(3);
  });

  it('expands qualified star', () => {
    const bound = bind("SELECT r.* FROM region r");
    expect(bound.selectItems.length).toBe(3);
  });

  it('detects ambiguous column', () => {
    expect(() => bind("SELECT n_nationkey FROM nation, nation n2")).toThrow(/[Aa]mbiguous/);
  });

  it('detects unknown table', () => {
    expect(() => bind("SELECT * FROM nonexistent")).toThrow(/[Uu]nknown table/);
  });

  it('detects unknown column', () => {
    expect(() => bind("SELECT nonexistent FROM region")).toThrow(/[Uu]nknown column/);
  });

  it('binds aggregates', () => {
    const bound = bind("SELECT COUNT(*), SUM(r_regionkey) FROM region");
    expect(bound.aggregates.length).toBe(2);
    expect(bound.aggregates[0].name).toBe('COUNT_STAR');
  });

  it('binds date literals', () => {
    const bound = bind("SELECT * FROM orders WHERE o_orderdate > DATE '1995-01-01'");
    expect(bound.where.right.kind).toBe(BoundExprKind.LITERAL);
    expect(typeof bound.where.right.value).toBe('number');
  });

  it('binds CASE expressions', () => {
    const bound = bind("SELECT CASE WHEN r_regionkey > 1 THEN 'big' ELSE 'small' END FROM region");
    expect(bound.selectItems[0].expr.kind).toBe(BoundExprKind.CASE);
  });

  it('binds BETWEEN', () => {
    const bound = bind("SELECT * FROM region WHERE r_regionkey BETWEEN 1 AND 3");
    expect(bound.where.kind).toBe(BoundExprKind.BETWEEN);
  });

  it('binds EXISTS subquery', () => {
    const bound = bind("SELECT * FROM region WHERE EXISTS (SELECT * FROM nation WHERE n_regionkey = r_regionkey)");
    expect(bound.where.kind).toBe(BoundExprKind.EXISTS);
  });

  it('binds IN subquery', () => {
    const bound = bind("SELECT * FROM region WHERE r_regionkey IN (SELECT n_regionkey FROM nation)");
    expect(bound.where.kind).toBe(BoundExprKind.IN_LIST);
  });

  it('binds JOIN conditions', () => {
    const bound = bind("SELECT * FROM nation JOIN region ON n_regionkey = r_regionkey");
    expect(bound.plan.condition.kind).toBe(BoundExprKind.BINARY);
  });

  it('binds GROUP BY and HAVING', () => {
    const bound = bind("SELECT n_regionkey, COUNT(*) FROM nation GROUP BY n_regionkey HAVING COUNT(*) > 2");
    expect(bound.groupBy.length).toBe(1);
    expect(bound.having.kind).toBe(BoundExprKind.BINARY);
  });
});

describe('Logical Planner', () => {
  it('produces Scan for simple query', () => {
    const p = plan("SELECT * FROM region");
    expect(p.type).toBe(PlanNodeType.PROJECT);
    expect(p.children[0].type).toBe(PlanNodeType.SCAN);
  });

  it('produces Filter for WHERE', () => {
    const p = plan("SELECT * FROM region WHERE r_regionkey > 1");
    expect(p.children[0].type).toBe(PlanNodeType.FILTER);
  });

  it('produces Join for JOIN', () => {
    const p = plan("SELECT * FROM nation JOIN region ON n_regionkey = r_regionkey");
    const projectChild = p.children[0];
    expect(projectChild.type).toBe(PlanNodeType.JOIN);
  });

  it('produces Aggregate for GROUP BY', () => {
    const p = plan("SELECT n_regionkey, COUNT(*) FROM nation GROUP BY n_regionkey");
    let node = p;
    while (node && node.type !== PlanNodeType.AGGREGATE) {
      node = node.children?.[0];
    }
    expect(node).not.toBeNull();
    expect(node.type).toBe(PlanNodeType.AGGREGATE);
  });

  it('produces Sort for ORDER BY', () => {
    const p = plan("SELECT * FROM region ORDER BY r_regionkey");
    expect(p.type).toBe(PlanNodeType.SORT);
  });

  it('produces Limit', () => {
    const p = plan("SELECT * FROM region LIMIT 5");
    expect(p.type).toBe(PlanNodeType.LIMIT);
    expect(p.count).toBe(5);
  });

  it('produces DependentJoin for correlated EXISTS', () => {
    const p = plan(`
      SELECT * FROM orders
      WHERE EXISTS (SELECT * FROM lineitem WHERE l_orderkey = o_orderkey)
    `);
    let found = false;
    function walk(node) {
      if (!node) return;
      if (node.type === PlanNodeType.DEPENDENT_JOIN) found = true;
      for (const child of node.children || []) walk(child);
    }
    walk(p);
    expect(found).toBe(true);
  });
});

describe('Binder + Planner - TPC-H Queries', () => {
  const tpchQueries = getTpchQueries();

  for (const [name, sql] of Object.entries(tpchQueries)) {
    it(`binds and plans ${name}`, () => {
      const p = plan(sql);
      expect(p).toBeDefined();
      expect(p.type).toBeDefined();
    });
  }
});

function getTpchQueries() {
  return {
    Q1: `
      SELECT l_returnflag, l_linestatus,
        SUM(l_quantity) AS sum_qty,
        SUM(l_extendedprice) AS sum_base_price,
        SUM(l_extendedprice * (1 - l_discount)) AS sum_disc_price,
        SUM(l_extendedprice * (1 - l_discount) * (1 + l_tax)) AS sum_charge,
        AVG(l_quantity) AS avg_qty, AVG(l_extendedprice) AS avg_price,
        AVG(l_discount) AS avg_disc, COUNT(*) AS count_order
      FROM lineitem
      WHERE l_shipdate <= DATE '1998-12-01' - INTERVAL '90' DAY
      GROUP BY l_returnflag, l_linestatus
      ORDER BY l_returnflag, l_linestatus
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
    Q14: `
      SELECT 100.00 * SUM(CASE WHEN p_type LIKE 'PROMO%' THEN l_extendedprice * (1 - l_discount) ELSE 0 END)
        / SUM(l_extendedprice * (1 - l_discount)) AS promo_revenue
      FROM lineitem, part
      WHERE l_partkey = p_partkey AND l_shipdate >= DATE '1995-09-01'
        AND l_shipdate < DATE '1995-09-01' + INTERVAL '1' MONTH
    `,
  };
}
