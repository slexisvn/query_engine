import { QueryEngine } from '../../src/index.js';
import { generateTPCHData } from '../fixtures/tpch-gen.js';

const data = await generateTPCHData();
const engine = new QueryEngine(data.catalog);
const tempManager = data.tempManager;

const queries = {
  Q1: `SELECT l_returnflag, l_linestatus, SUM(l_quantity) AS sum_qty, SUM(l_extendedprice) AS sum_base_price,
       SUM(l_extendedprice * (1 - l_discount)) AS sum_disc_price, COUNT(*) AS count_order
       FROM lineitem WHERE l_shipdate <= DATE '1998-12-01' - INTERVAL '90' DAY
       GROUP BY l_returnflag, l_linestatus ORDER BY l_returnflag, l_linestatus`,
  Q3: `SELECT l_orderkey, SUM(l_extendedprice * (1 - l_discount)) AS revenue, o_orderdate, o_shippriority
       FROM customer, orders, lineitem
       WHERE c_mktsegment = 'BUILDING' AND c_custkey = o_custkey AND l_orderkey = o_orderkey
       AND o_orderdate < DATE '1995-03-15' AND l_shipdate > DATE '1995-03-15'
       GROUP BY l_orderkey, o_orderdate, o_shippriority ORDER BY revenue DESC, o_orderdate LIMIT 10`,
  Q5: `SELECT n_name, SUM(l_extendedprice * (1 - l_discount)) AS revenue
       FROM customer, orders, lineitem, supplier, nation, region
       WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey AND l_suppkey = s_suppkey
       AND c_nationkey = s_nationkey AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey
       AND r_name = 'ASIA' AND o_orderdate >= DATE '1994-01-01' AND o_orderdate < DATE '1994-01-01' + INTERVAL '1' YEAR
       GROUP BY n_name ORDER BY revenue DESC`,
  Q6: `SELECT SUM(l_extendedprice * l_discount) AS revenue FROM lineitem
       WHERE l_shipdate >= DATE '1994-01-01' AND l_shipdate < DATE '1994-01-01' + INTERVAL '1' YEAR
       AND l_discount BETWEEN 0.05 AND 0.07 AND l_quantity < 24`,
  Q12: `SELECT l_shipmode, SUM(CASE WHEN o_orderpriority = '1-URGENT' OR o_orderpriority = '2-HIGH' THEN 1 ELSE 0 END) AS high_line_count,
        SUM(CASE WHEN o_orderpriority <> '1-URGENT' AND o_orderpriority <> '2-HIGH' THEN 1 ELSE 0 END) AS low_line_count
        FROM orders, lineitem WHERE o_orderkey = l_orderkey AND l_shipmode IN ('MAIL', 'SHIP')
        AND l_commitdate < l_receiptdate AND l_shipdate < l_commitdate
        AND l_receiptdate >= DATE '1994-01-01' AND l_receiptdate < DATE '1994-01-01' + INTERVAL '1' YEAR
        GROUP BY l_shipmode ORDER BY l_shipmode`,
};

const WARMUP = 2;
const ITERATIONS = 5;

async function bench() {
  console.log('TPC-H Benchmark (SF=0.01)');
  console.log('='.repeat(50));

  for (const [name, sql] of Object.entries(queries)) {
    for (let i = 0; i < WARMUP; i++) await engine.run(sql);

    const times = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      const result = await engine.run(sql);
      const elapsed = performance.now() - start;
      times.push(elapsed);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    console.log(`${name.padEnd(5)} avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}ms`);
  }
}

bench().catch(console.error).finally(() => tempManager.cleanup());
