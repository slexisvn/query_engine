import { QueryEngine } from '../src/index.js';
import { generateTPCHData } from '../test/fixtures/tpch-gen.js';
import { formatPlan } from '../src/planner/plan-formatter.js';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TPCH_QUERIES = {
  Q1: `SELECT l_returnflag, l_linestatus,
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
  ORDER BY l_returnflag, l_linestatus`,

  Q3: `SELECT l_orderkey, SUM(l_extendedprice * (1 - l_discount)) AS revenue,
    o_orderdate, o_shippriority
  FROM customer, orders, lineitem
  WHERE c_mktsegment = 'BUILDING' AND c_custkey = o_custkey AND l_orderkey = o_orderkey
    AND o_orderdate < DATE '1995-03-15' AND l_shipdate > DATE '1995-03-15'
  GROUP BY l_orderkey, o_orderdate, o_shippriority
  ORDER BY revenue DESC, o_orderdate
  LIMIT 10`,

  Q4: `SELECT o_orderpriority, COUNT(*) AS order_count
  FROM orders
  WHERE o_orderdate >= DATE '1993-07-01' AND o_orderdate < DATE '1993-07-01' + INTERVAL '3' MONTH
    AND EXISTS (
      SELECT * FROM lineitem WHERE l_orderkey = o_orderkey AND l_commitdate < l_receiptdate
    )
  GROUP BY o_orderpriority
  ORDER BY o_orderpriority`,

  Q5: `SELECT n_name, SUM(l_extendedprice * (1 - l_discount)) AS revenue
  FROM customer, orders, lineitem, supplier, nation, region
  WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey AND l_suppkey = s_suppkey
    AND c_nationkey = s_nationkey AND s_nationkey = n_nationkey AND n_regionkey = r_regionkey
    AND r_name = 'ASIA' AND o_orderdate >= DATE '1994-01-01'
    AND o_orderdate < DATE '1994-01-01' + INTERVAL '1' YEAR
  GROUP BY n_name
  ORDER BY revenue DESC`,

  Q6: `SELECT SUM(l_extendedprice * l_discount) AS revenue
  FROM lineitem
  WHERE l_shipdate >= DATE '1994-01-01' AND l_shipdate < DATE '1994-01-01' + INTERVAL '1' YEAR
    AND l_discount BETWEEN 0.05 AND 0.07 AND l_quantity < 24`,

  Q7: `SELECT n1.n_name AS supp_nation, n2.n_name AS cust_nation,
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
  ORDER BY supp_nation, cust_nation, l_year`,

  Q8: `SELECT o_year,
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
  ORDER BY o_year`,

  Q9: `SELECT nation, o_year, SUM(amount) AS sum_profit
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
  ORDER BY nation, o_year DESC`,

  Q10: `SELECT c_custkey, c_name, SUM(l_extendedprice * (1 - l_discount)) AS revenue,
    c_acctbal, n_name, c_address, c_phone, c_comment
  FROM customer, orders, lineitem, nation
  WHERE c_custkey = o_custkey AND l_orderkey = o_orderkey
    AND o_orderdate >= DATE '1993-10-01' AND o_orderdate < DATE '1993-10-01' + INTERVAL '3' MONTH
    AND l_returnflag = 'R' AND c_nationkey = n_nationkey
  GROUP BY c_custkey, c_name, c_acctbal, c_phone, n_name, c_address, c_comment
  ORDER BY revenue DESC
  LIMIT 20`,

  Q11: `SELECT ps_partkey, SUM(ps_supplycost * ps_availqty) AS value
  FROM partsupp, supplier, nation
  WHERE ps_suppkey = s_suppkey AND s_nationkey = n_nationkey AND n_name = 'GERMANY'
  GROUP BY ps_partkey
  HAVING SUM(ps_supplycost * ps_availqty) > (
    SELECT SUM(ps_supplycost * ps_availqty) * 0.0001
    FROM partsupp, supplier, nation
    WHERE ps_suppkey = s_suppkey AND s_nationkey = n_nationkey AND n_name = 'GERMANY'
  )
  ORDER BY value DESC`,

  Q12: `SELECT l_shipmode,
    SUM(CASE WHEN o_orderpriority = '1-URGENT' OR o_orderpriority = '2-HIGH' THEN 1 ELSE 0 END) AS high_line_count,
    SUM(CASE WHEN o_orderpriority <> '1-URGENT' AND o_orderpriority <> '2-HIGH' THEN 1 ELSE 0 END) AS low_line_count
  FROM orders, lineitem
  WHERE o_orderkey = l_orderkey AND l_shipmode IN ('MAIL', 'SHIP')
    AND l_commitdate < l_receiptdate AND l_shipdate < l_commitdate
    AND l_receiptdate >= DATE '1994-01-01' AND l_receiptdate < DATE '1994-01-01' + INTERVAL '1' YEAR
  GROUP BY l_shipmode
  ORDER BY l_shipmode`,

  Q13: `SELECT c_count, COUNT(*) AS custdist
  FROM (
    SELECT c_custkey, COUNT(o_orderkey) AS c_count
    FROM customer LEFT OUTER JOIN orders ON c_custkey = o_custkey
      AND o_comment NOT LIKE '%special%requests%'
    GROUP BY c_custkey
  ) AS c_orders
  GROUP BY c_count
  ORDER BY custdist DESC, c_count DESC`,

  Q14: `SELECT 100.00 * SUM(CASE WHEN p_type LIKE 'PROMO%' THEN l_extendedprice * (1 - l_discount) ELSE 0 END)
    / SUM(l_extendedprice * (1 - l_discount)) AS promo_revenue
  FROM lineitem, part
  WHERE l_partkey = p_partkey AND l_shipdate >= DATE '1995-09-01'
    AND l_shipdate < DATE '1995-09-01' + INTERVAL '1' MONTH`,

  Q15: `WITH revenue AS (
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
  ORDER BY s_suppkey`,

  Q16: `SELECT p_brand, p_type, p_size, COUNT(DISTINCT ps_suppkey) AS supplier_cnt
  FROM partsupp, part
  WHERE p_partkey = ps_partkey AND p_brand <> 'Brand#45'
    AND p_type NOT LIKE 'MEDIUM POLISHED%'
    AND p_size IN (49, 14, 23, 45, 19, 3, 36, 9)
    AND ps_suppkey NOT IN (
      SELECT s_suppkey FROM supplier WHERE s_comment LIKE '%Customer%Complaints%'
    )
  GROUP BY p_brand, p_type, p_size
  ORDER BY supplier_cnt DESC, p_brand, p_type, p_size`,

  Q17: `SELECT SUM(l_extendedprice) / 7.0 AS avg_yearly
  FROM lineitem, part
  WHERE p_partkey = l_partkey AND p_brand = 'Brand#23'
    AND p_container = 'MED BOX'
    AND l_quantity < (
      SELECT 0.2 * AVG(l_quantity)
      FROM lineitem
      WHERE l_partkey = p_partkey
    )`,

  Q18: `SELECT c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice,
    SUM(l_quantity) AS total_qty
  FROM customer, orders, lineitem
  WHERE o_orderkey IN (
      SELECT l_orderkey FROM lineitem GROUP BY l_orderkey HAVING SUM(l_quantity) > 300
    )
    AND c_custkey = o_custkey AND o_orderkey = l_orderkey
  GROUP BY c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice
  ORDER BY o_totalprice DESC, o_orderdate
  LIMIT 100`,

  Q19: `SELECT SUM(l_extendedprice * (1 - l_discount)) AS revenue
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
    )`,

  Q20: `SELECT s_name, s_address
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
  ORDER BY s_name`,

  Q21: `SELECT s_name, COUNT(*) AS numwait
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

  Q22: `SELECT cntrycode, COUNT(*) AS numcust, SUM(c_acctbal) AS totacctbal
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
  GROUP BY cntrycode
  ORDER BY cntrycode`,
};

function extractMyOperators(planText) {
  const ops = [];
  for (const line of planText.split('\n')) {
    const trimmed = line.replace(/^[\s│├└─┬┼|]+/, '').trim();
    if (!trimmed) continue;
    const cleaned = trimmed.replace(/^->\s*/, '');
    if (cleaned) ops.push(cleaned);
  }
  return ops;
}

function classifyOp(opStr) {
  const u = opStr.toUpperCase();
  if (/HASH\s*(INNER\s*)?JOIN|HASH_JOIN/.test(u)) return 'HASH_JOIN';
  if (/MERGE\s*(INNER\s*)?JOIN|PIECEWISE_MERGE_JOIN|MERGE_JOIN/.test(u)) return 'MERGE_JOIN';
  if (/NESTED\s*LOOP|NESTED_LOOP|BLOCKWISE/.test(u)) return 'NESTED_LOOP_JOIN';
  if (/CROSS\s*(JOIN|PRODUCT)/.test(u)) return 'CROSS_JOIN';
  if (/DELIM_JOIN/.test(u)) return 'MARK_JOIN';
  if (/MARK\s*JOIN/.test(u)) return 'MARK_JOIN';
  if (/HASH\s*SEMI\s*JOIN/.test(u)) return 'SEMI_JOIN';
  if (/HASH\s*ANTI\s*JOIN/.test(u)) return 'ANTI_JOIN';
  if (/SEMI\s*JOIN/.test(u)) return 'SEMI_JOIN';
  if (/ANTI\s*JOIN/.test(u)) return 'ANTI_JOIN';
  if (/LEFT\s*(OUTER\s*)?JOIN/.test(u)) return 'LEFT_JOIN';
  if (/RIGHT\s*(OUTER\s*)?JOIN/.test(u)) return 'RIGHT_JOIN';
  if (/HASH\s*LEFT\s*JOIN/.test(u)) return 'LEFT_JOIN';
  if (/\bJOIN\b/.test(u) && !/SEMI|ANTI|LEFT|RIGHT|MARK|CROSS|DELIM/.test(u)) return 'HASH_JOIN';

  if (/PERFECT_HASH_GROUP_BY|PERFECT\s*HASH\s*(AGGREGATE|GROUP)/.test(u)) return 'PERFECT_HASH_AGGREGATE';
  if (/HASH_GROUP_BY|HASH\s*(AGGREGATE|GROUP)/.test(u)) return 'HASH_AGGREGATE';
  if (/STREAMING_WINDOW|STREAM\s*AGGREGATE/.test(u)) return 'STREAM_AGGREGATE';
  if (/UNGROUPED_AGGREGATE|UNGROUPED\s*AGGREGATE/.test(u)) return 'UNGROUPED_AGGREGATE';
  if (/AGGREGATE|GROUP_BY/.test(u)) return 'HASH_AGGREGATE';

  if (/TOP.?N/.test(u)) return 'TOP_N';
  if (/\bSORT\b/.test(u) && !/ORDER/.test(u)) return 'SORT';
  if (/ORDER_BY|ORDER\b/.test(u)) return 'SORT';
  if (/\bLIMIT\b/.test(u)) return 'LIMIT';
  if (/\bFILTER\b/.test(u)) return 'FILTER';
  if (/\bPROJECT/.test(u)) return 'PROJECT';
  if (/SEQ_SCAN|SEQ\s*SCAN|TABLE\s*SCAN/.test(u)) return 'SCAN';
  if (/\bSCAN\b/.test(u) && !/CTE|DELIM|CHUNK|COLUMN/.test(u)) return 'SCAN';
  if (/CTE/.test(u)) return 'CTE';
  if (/DEPENDENT\s*JOIN/.test(u)) return 'DEPENDENT_JOIN';
  if (/DELIM_SCAN/.test(u)) return 'DELIM_SCAN';

  return null;
}

function analyzePlanFromOps(rawOps) {
  const classified = rawOps.map(classifyOp).filter(Boolean);

  const joinTypes = classified.filter(c =>
    c.endsWith('_JOIN') && c !== 'DEPENDENT_JOIN'
  );
  const aggTypes = classified.filter(c => c.includes('AGGREGATE'));
  const scanCount = classified.filter(c => c === 'SCAN').length;
  const hasFilter = classified.includes('FILTER');
  const hasSort = classified.includes('SORT');
  const hasLimit = classified.includes('LIMIT');
  const hasTopN = classified.includes('TOP_N');
  const hasDependentJoin = classified.includes('DEPENDENT_JOIN');
  const hasCTE = classified.includes('CTE');

  return {
    ops: classified,
    joinTypes,
    aggTypes,
    scanCount,
    hasFilter,
    hasSort,
    hasLimit,
    hasTopN,
    hasDependentJoin,
    hasCTE,
    totalOps: classified.length,
  };
}

function comparePlans(myPlanText, duckOps) {
  const myRawOps = extractMyOperators(myPlanText);
  const mine = analyzePlanFromOps(myRawOps);
  const duck = analyzePlanFromOps(duckOps);
  const similar = [];
  const different = [];

  if (mine.joinTypes.length === duck.joinTypes.length) {
    similar.push(`Same join count: ${mine.joinTypes.length}`);
  } else {
    different.push(`Join count: mine=${mine.joinTypes.length}, duck=${duck.joinTypes.length}`);
  }

  const myJoinSet = [...new Set(mine.joinTypes)].sort();
  const duckJoinSet = [...new Set(duck.joinTypes)].sort();
  const commonJoins = myJoinSet.filter(j => duckJoinSet.includes(j));
  if (commonJoins.length > 0) {
    similar.push(`Common join strategies: ${commonJoins.join(', ')}`);
  }
  const myOnlyJoins = myJoinSet.filter(j => !duckJoinSet.includes(j));
  const duckOnlyJoins = duckJoinSet.filter(j => !myJoinSet.includes(j));
  if (myOnlyJoins.length > 0 || duckOnlyJoins.length > 0) {
    different.push(`Join strategies differ - mine: [${myOnlyJoins.join(', ')}], duck: [${duckOnlyJoins.join(', ')}]`);
  }

  if (mine.scanCount === duck.scanCount) {
    similar.push(`Same scan count: ${mine.scanCount}`);
  } else {
    different.push(`Scan count: mine=${mine.scanCount}, duck=${duck.scanCount}`);
  }

  const myAggSet = [...new Set(mine.aggTypes)].sort();
  const duckAggSet = [...new Set(duck.aggTypes)].sort();
  if (myAggSet.join(',') === duckAggSet.join(',')) {
    if (myAggSet.length > 0) similar.push(`Same agg strategy: ${myAggSet.join(', ')}`);
  } else {
    if (myAggSet.length > 0 || duckAggSet.length > 0) {
      different.push(`Agg strategies differ - mine: [${myAggSet.join(', ')}], duck: [${duckAggSet.join(', ')}]`);
    }
  }

  if (!mine.hasDependentJoin && !duck.hasDependentJoin) {
    similar.push('Both fully unnested subqueries');
  } else if (mine.hasDependentJoin && !duck.hasDependentJoin) {
    different.push('My engine kept dependent join(s); DuckDB unnested them');
  } else if (!mine.hasDependentJoin && duck.hasDependentJoin) {
    similar.push('My engine unnested subqueries that DuckDB kept as dependent');
  }

  if (mine.hasTopN && duck.hasTopN) {
    similar.push('Both use TopN optimization');
  } else if (!mine.hasTopN && duck.hasTopN) {
    different.push('DuckDB uses TopN; my engine uses Sort+Limit separately');
  } else if (mine.hasTopN && !duck.hasTopN) {
    similar.push('My engine uses TopN; DuckDB does not');
  }

  const mySemi = mine.joinTypes.filter(j => j === 'SEMI_JOIN').length;
  const duckSemi = duck.joinTypes.filter(j => j === 'SEMI_JOIN').length;
  const myAnti = mine.joinTypes.filter(j => j === 'ANTI_JOIN').length;
  const duckAnti = duck.joinTypes.filter(j => j === 'ANTI_JOIN').length;
  const myMark = mine.joinTypes.filter(j => j === 'MARK_JOIN').length;
  const duckMark = duck.joinTypes.filter(j => j === 'MARK_JOIN').length;

  if (mySemi === duckSemi && mySemi > 0) similar.push(`Both use ${mySemi} semi join(s)`);
  if (myAnti === duckAnti && myAnti > 0) similar.push(`Both use ${myAnti} anti join(s)`);
  if (myMark === duckMark && myMark > 0) similar.push(`Both use ${myMark} mark join(s)`);

  return { similar, different, mine, duck };
}

async function main() {
  console.log('=== TPC-H Plan Comparison: My Query Engine vs DuckDB ===\n');

  // Step 1: Get DuckDB plans
  console.log('Getting DuckDB plans...');
  const pyScript = resolve(__dirname, 'duckdb-plans.py');
  const duckPlansRaw = execSync(`python -X utf8 "${pyScript}"`, {
    encoding: 'utf-8',
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const duckPlans = JSON.parse(duckPlansRaw);
  console.log(`Got DuckDB plans for ${Object.keys(duckPlans).length} queries.\n`);

  // Step 2: Initialize my engine
  console.log('Initializing my query engine with TPC-H SF=0.01...');
  const data = await generateTPCHData();
  const engine = new QueryEngine(data.catalog);
  const stats = await engine.collectStatistics();
  engine.optimizer = engine.createOptimizer(stats);
  engine.precomputedStats = stats;
  console.log('Engine ready.\n');

  // Step 3: Compare each query
  const summaryRows = [];
  let totalSimilar = 0;
  let totalDiff = 0;
  let successCount = 0;

  for (const [qName, sql] of Object.entries(TPCH_QUERIES)) {
    console.log(`${'='.repeat(90)}`);
    console.log(`  ${qName}`);
    console.log(`${'='.repeat(90)}`);

    // My engine plan
    let myPlanStr;
    try {
      const { plan } = await engine.compile(sql);
      myPlanStr = formatPlan(plan);
    } catch (e) {
      console.log(`  [MY ENGINE ERROR] ${e.message}`);
      summaryRows.push({ query: qName, status: 'MY_ERROR', similar: 0, diff: 0, note: e.message.substring(0, 60) });
      continue;
    }

    // DuckDB plan
    const duckEntry = duckPlans[qName];
    if (!duckEntry || duckEntry.error) {
      console.log(`  [DUCKDB ERROR] ${duckEntry?.error || 'missing'}`);
      summaryRows.push({ query: qName, status: 'DUCK_ERROR', similar: 0, diff: 0, note: (duckEntry?.error || '').substring(0, 60) });
      continue;
    }
    const duckPlanStr = duckEntry.plan;

    // Print both plans
    console.log('\n  MY ENGINE:');
    for (const line of myPlanStr.split('\n').filter(l => l.trim())) {
      console.log(`    ${line}`);
    }
    console.log('\n  DUCKDB:');
    for (const line of duckPlanStr.split('\n').filter(l => l.trim())) {
      console.log(`    ${line}`);
    }

    const duckOps = duckEntry.operators || [];
    const result = comparePlans(myPlanStr, duckOps);
    console.log('\n  COMPARISON:');
    for (const s of result.similar) console.log(`    [=] ${s}`);
    for (const d of result.different) console.log(`    [!] ${d}`);

    totalSimilar += result.similar.length;
    totalDiff += result.different.length;
    successCount++;

    summaryRows.push({
      query: qName,
      status: 'OK',
      similar: result.similar.length,
      diff: result.different.length,
      note: result.different.length === 0 ? 'MATCH' : result.different[0].substring(0, 50),
    });

    console.log('');
  }

  // Summary table
  console.log(`\n${'='.repeat(90)}`);
  console.log('  SUMMARY');
  console.log(`${'='.repeat(90)}`);
  console.log(`  ${'Query'.padEnd(8)} ${'Status'.padEnd(12)} ${'Similar'.padEnd(10)} ${'Diff'.padEnd(8)} Note`);
  console.log(`  ${'─'.repeat(85)}`);
  for (const row of summaryRows) {
    console.log(`  ${row.query.padEnd(8)} ${row.status.padEnd(12)} ${String(row.similar).padEnd(10)} ${String(row.diff).padEnd(8)} ${row.note || ''}`);
  }
  console.log(`  ${'─'.repeat(85)}`);
  const score = totalSimilar + totalDiff > 0
    ? Math.round(totalSimilar / (totalSimilar + totalDiff) * 100)
    : 0;
  console.log(`  Queries compared successfully: ${successCount}/${Object.keys(TPCH_QUERIES).length}`);
  console.log(`  Total similar aspects: ${totalSimilar}`);
  console.log(`  Total different aspects: ${totalDiff}`);
  console.log(`  Overall similarity score: ${score}%`);
}

main().catch(e => { console.error(e); process.exit(1); });
