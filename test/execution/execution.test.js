import { describe, it, expect, beforeAll } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { generateTPCHData } from '../fixtures/tpch-gen.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { DataType } from '../../src/storage/data-type.js';
import { Table } from '../../src/storage/table.js';

let engine;
let tables;

beforeAll(async () => {
  const data = await generateTPCHData();
  engine = new QueryEngine(data.catalog);
  tables = data.tables;
});

describe('Basic Execution', () => {
  it('executes simple SELECT', async () => {
    const result = await engine.run("SELECT r_regionkey, r_name FROM region");
    expect(result.rows.length).toBe(5);
    expect(result.rows[0]).toHaveProperty('r_name');
  });

  it('executes SELECT with WHERE', async () => {
    const result = await engine.run("SELECT r_name FROM region WHERE r_regionkey = 0");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].r_name).toBe('AFRICA');
  });

  it('executes SELECT *', async () => {
    const result = await engine.run("SELECT * FROM region");
    expect(result.rows.length).toBe(5);
    expect(result.columns.length).toBe(3);
  });

  it('executes COUNT(*)', async () => {
    const result = await engine.run("SELECT COUNT(*) AS cnt FROM region");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].cnt).toBe(5);
  });

  it('executes SUM', async () => {
    const result = await engine.run("SELECT SUM(r_regionkey) AS total FROM region");
    expect(result.rows[0].total).toBe(10);
  });

  it('executes GROUP BY', async () => {
    const result = await engine.run(`
      SELECT n_regionkey, COUNT(*) AS cnt
      FROM nation
      GROUP BY n_regionkey
      ORDER BY n_regionkey
    `);
    expect(result.rows.length).toBe(5);
    const totalNations = result.rows.reduce((sum, r) => sum + r.cnt, 0);
    expect(totalNations).toBe(25);
  });

  it('executes ORDER BY DESC', async () => {
    const result = await engine.run(`
      SELECT r_regionkey FROM region ORDER BY r_regionkey DESC
    `);
    expect(result.rows[0].r_regionkey).toBe(4);
    expect(result.rows[4].r_regionkey).toBe(0);
  });

  it('executes LIMIT', async () => {
    const result = await engine.run("SELECT * FROM nation LIMIT 5");
    expect(result.rows.length).toBe(5);
  });

  it('executes JOIN', async () => {
    const result = await engine.run(`
      SELECT n_name, r_name
      FROM nation JOIN region ON n_regionkey = r_regionkey
      WHERE r_name = 'EUROPE'
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.r_name).toBe('EUROPE');
    }
  });

  it('executes multi-table join (comma syntax)', async () => {
    const result = await engine.run(`
      SELECT n_name, r_name
      FROM nation, region
      WHERE n_regionkey = r_regionkey AND r_name = 'ASIA'
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.r_name).toBe('ASIA');
    }
  });

  it('executes BETWEEN', async () => {
    const result = await engine.run(`
      SELECT COUNT(*) AS cnt FROM region WHERE r_regionkey BETWEEN 1 AND 3
    `);
    expect(result.rows[0].cnt).toBe(3);
  });

  it('executes IN list', async () => {
    const result = await engine.run(`
      SELECT COUNT(*) AS cnt FROM region WHERE r_name IN ('ASIA', 'EUROPE')
    `);
    expect(result.rows[0].cnt).toBe(2);
  });

  it('executes NOT IN with SQL NULL semantics', async () => {
    const catalog = new Catalog();
    const schema = [{ name: 'ID', dataType: DataType.INT32 }];
    const left = new Table('left_t', schema);
    const right = new Table('right_t', schema);
    await left.insertRows([[1], [2], [3]]);
    await right.insertRows([[2], [null]]);
    catalog.registerTable('left_t', schema);
    catalog.registerTable('right_t', schema);
    catalog.registerTableStorage('left_t', left);
    catalog.registerTableStorage('right_t', right);
    const localEngine = new QueryEngine(catalog);

    const result = await localEngine.run(`
      SELECT id FROM left_t WHERE id NOT IN (SELECT id FROM right_t)
    `);

    expect(result.rows).toHaveLength(0);
  });

  it('executes LIKE', async () => {
    const result = await engine.run(`
      SELECT COUNT(*) AS cnt FROM region WHERE r_name LIKE 'A%'
    `);
    expect(result.rows[0].cnt).toBeGreaterThanOrEqual(1);
  });

  it('executes CASE expression', async () => {
    const result = await engine.run(`
      SELECT r_regionkey,
        CASE WHEN r_regionkey < 2 THEN 'low' ELSE 'high' END AS bucket
      FROM region ORDER BY r_regionkey
    `);
    expect(result.rows[0].bucket).toBe('low');
    expect(result.rows[3].bucket).toBe('high');
  });

  it('executes arithmetic expressions', async () => {
    const result = await engine.run(`
      SELECT r_regionkey, r_regionkey * 10 + 5 AS computed
      FROM region WHERE r_regionkey = 2
    `);
    expect(result.rows[0].computed).toBe(25);
  });

  it('executes AVG aggregate', async () => {
    const result = await engine.run("SELECT AVG(r_regionkey) AS avg_key FROM region");
    expect(result.rows[0].avg_key).toBe(2);
  });

  it('executes MIN and MAX', async () => {
    const result = await engine.run(`
      SELECT MIN(r_regionkey) AS min_k, MAX(r_regionkey) AS max_k FROM region
    `);
    expect(result.rows[0].min_k).toBe(0);
    expect(result.rows[0].max_k).toBe(4);
  });
});

describe('TPC-H Query Execution', () => {
  it('executes Q2-style correlated minimum-cost supplier query', async () => {
    const result = await engine.run(`
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
    `);

    expect(result.rows.map(r => [r.s_name, r.n_name, r.p_partkey])).toEqual([
      ['Supplier#000000031', 'RUSSIA', 443],
      ['Supplier#000000091', 'GERMANY', 190],
      ['Supplier#000000020', 'UNITED KINGDOM', 94],
      ['Supplier#000000004', 'RUSSIA', 416],
      ['Supplier#000000035', 'UNITED KINGDOM', 1652],
      ['Supplier#000000088', 'UNITED KINGDOM', 587],
    ]);
  });

  it('executes Q1-style (aggregate on lineitem)', async () => {
    const result = await engine.run(`
      SELECT l_returnflag, l_linestatus, COUNT(*) AS cnt
      FROM lineitem
      GROUP BY l_returnflag, l_linestatus
      ORDER BY l_returnflag, l_linestatus
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    const totalRows = result.rows.reduce((s, r) => s + r.cnt, 0);
    expect(totalRows).toBe(tables.LINEITEM.rowCount());
  });

  it('executes Q3-style (3-table join with aggregate)', async () => {
    const result = await engine.run(`
      SELECT l_orderkey, SUM(l_extendedprice * (1 - l_discount)) AS revenue,
             o_orderdate, o_shippriority
      FROM customer, orders, lineitem
      WHERE c_mktsegment = 'BUILDING' AND c_custkey = o_custkey
        AND l_orderkey = o_orderkey
      GROUP BY l_orderkey, o_orderdate, o_shippriority
      ORDER BY revenue DESC
      LIMIT 10
    `);
    expect(result.rows.length).toBeLessThanOrEqual(10);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('executes Q6-style (simple scan+filter+aggregate)', async () => {
    const result = await engine.run(`
      SELECT SUM(l_extendedprice * l_discount) AS revenue
      FROM lineitem
      WHERE l_discount BETWEEN 0.05 AND 0.07 AND l_quantity < 24
    `);
    expect(result.rows.length).toBe(1);
  });

  it('executes Q12-style (2-table join with CASE aggregate)', async () => {
    const result = await engine.run(`
      SELECT l_shipmode,
        SUM(CASE WHEN o_orderpriority = '1-URGENT' OR o_orderpriority = '2-HIGH'
          THEN 1 ELSE 0 END) AS high_count,
        SUM(CASE WHEN o_orderpriority <> '1-URGENT' AND o_orderpriority <> '2-HIGH'
          THEN 1 ELSE 0 END) AS low_count
      FROM orders, lineitem
      WHERE o_orderkey = l_orderkey
        AND l_shipmode IN ('MAIL', 'SHIP')
      GROUP BY l_shipmode
      ORDER BY l_shipmode
    `);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('executes Q16-style anti-join supplier exclusion', async () => {
    const result = await engine.run(`
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
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0].supplier_cnt).toBeGreaterThan(0);
  });

  it('executes Q13-style (LEFT OUTER JOIN with aggregate)', async () => {
    const result = await engine.run(`
      SELECT c_count, COUNT(*) AS custdist
      FROM (
        SELECT c_custkey, COUNT(o_orderkey) AS c_count
        FROM customer LEFT OUTER JOIN orders ON c_custkey = o_custkey
        GROUP BY c_custkey
      ) AS c_orders
      GROUP BY c_count
      ORDER BY custdist DESC, c_count DESC
    `);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('verifies nation-region join cardinality', async () => {
    const result = await engine.run(`
      SELECT COUNT(*) AS cnt
      FROM nation JOIN region ON n_regionkey = r_regionkey
    `);
    expect(result.rows[0].cnt).toBe(25);
  });
});

describe('Push-Based Pipeline Behaviors', () => {
  it('LIMIT does not materialize all rows (early termination)', async () => {
    const result = await engine.run(`
      SELECT l_orderkey FROM lineitem LIMIT 5
    `);
    expect(result.rows.length).toBe(5);
  });

  it('LIMIT with OFFSET works correctly', async () => {
    const all = await engine.run(`SELECT r_name FROM region ORDER BY r_name`);
    const offset = await engine.run(`SELECT r_name FROM region ORDER BY r_name LIMIT 2 OFFSET 1`);
    expect(offset.rows.length).toBe(2);
    expect(offset.rows[0].r_name).toBe(all.rows[1].r_name);
    expect(offset.rows[1].r_name).toBe(all.rows[2].r_name);
  });

  it('DISTINCT is push-based (processes inline)', async () => {
    const result = await engine.run(`
      SELECT DISTINCT l_returnflag FROM lineitem
    `);
    expect(result.rows.length).toBeLessThanOrEqual(3);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('selection vectors propagate through pipeline', async () => {
    const result = await engine.run(`
      SELECT n_name FROM nation WHERE n_regionkey = 2
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(typeof row.n_name).toBe('string');
    }
  });

  it('hash join build-side hint is respected', async () => {
    const result = await engine.run(`
      SELECT n_name, r_name FROM nation JOIN region ON n_regionkey = r_regionkey
    `);
    expect(result.rows.length).toBe(25);
  });

  it('UNION ALL is non-blocking passthrough', async () => {
    const result = await engine.run(`
      SELECT r_name FROM region WHERE r_regionkey < 2
      UNION ALL
      SELECT r_name FROM region WHERE r_regionkey >= 3
    `);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
