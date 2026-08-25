export interface Example {
  name: string;
  teaches: string;
  passes: readonly string[];
  sql: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    name: 'Pushdown and Top-N',
    teaches: 'Drops the pointless 1 = 1, slides the WHERE below the join so it filters before matching, then fuses ORDER BY + LIMIT into one Top-N.',
    passes: ['ExpressionSimplifier', 'PredicatePushdown', 'TopNFusion'],
    sql: `SELECT c.C_NAME, o.O_TOTALPRICE
FROM CUSTOMER c
  JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE c.C_MKTSEGMENT = 'BUILDING' AND 1 = 1
ORDER BY o.O_TOTALPRICE DESC
LIMIT 10`,
  },
  {
    name: 'Join reorder',
    teaches: 'The optimizer picks the join order from statistics, not from your SQL. Raise the NATION row count in the catalog and watch it move to the other end of the tree.',
    passes: ['JoinReorder'],
    sql: `SELECT s.S_NAME, p.P_NAME
FROM PARTSUPP ps
  JOIN PART p ON p.P_PARTKEY = ps.PS_PARTKEY
  JOIN SUPPLIER s ON s.S_SUPPKEY = ps.PS_SUPPKEY
  JOIN NATION n ON n.N_NATIONKEY = s.S_NATIONKEY
WHERE p.P_SIZE = 15 AND n.N_NAME = 'VIETNAM'`,
  },
  {
    name: 'Predicate inference',
    teaches: 'Only ORDERS is filtered in the SQL. Because the join is an equality, the same filter must hold on LINEITEM — so the optimizer derives it and pushes it down.',
    passes: ['PredicateInference', 'PredicatePushdown'],
    sql: `SELECT o.O_ORDERKEY, l.L_QUANTITY
FROM ORDERS o
  JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
WHERE o.O_ORDERKEY = 42`,
  },
  {
    name: 'Correlated EXISTS',
    teaches: 'A correlated EXISTS reads like a loop: for every customer, run a subquery. The optimizer rewrites it into a single semi join.',
    passes: ['SubqueryUnnesting'],
    sql: `SELECT c.C_NAME
FROM CUSTOMER c
WHERE EXISTS (
  SELECT 1 FROM ORDERS o
  WHERE o.O_CUSTKEY = c.C_CUSTKEY AND o.O_TOTALPRICE > 100000
)`,
  },
  {
    name: 'Outer join downgrade',
    teaches: 'Both WHERE clauses reject NULLs, so the padded rows a FULL JOIN would add can never survive. Downgrading it to an INNER JOIN costs nothing by itself — the payoff is the next pass, which can finally push each filter onto its own table.',
    passes: ['OuterToInnerJoin', 'PredicatePushdown'],
    sql: `SELECT c.C_NAME, o.O_TOTALPRICE
FROM CUSTOMER c
  FULL JOIN ORDERS o ON o.O_CUSTKEY = c.C_CUSTKEY
WHERE o.O_TOTALPRICE > 50000 AND c.C_ACCTBAL > 0`,
  },
  {
    name: 'Aggregate and having',
    teaches: 'HAVING runs after grouping, but a HAVING condition on a grouping column can run before it — as an ordinary filter on far more rows.',
    passes: ['HavingPushdown', 'ProjectionPushdown'],
    sql: `SELECT o.O_ORDERSTATUS, SUM(l.L_EXTENDEDPRICE) AS revenue
FROM ORDERS o
  JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
GROUP BY o.O_ORDERSTATUS
HAVING o.O_ORDERSTATUS = 'F' AND SUM(l.L_EXTENDEDPRICE) > 1000`,
  },
  {
    name: 'Index selection',
    teaches: 'A filter selective enough to beat reading the whole table turns into an index scan.',
    passes: ['IndexSelection'],
    sql: `SELECT O_ORDERKEY, O_TOTALPRICE
FROM ORDERS
WHERE O_ORDERKEY = 42`,
  },
  {
    name: 'Distinct elimination',
    teaches: 'C_CUSTKEY is the primary key, so the rows are already unique. The optimizer proves it and deletes the DISTINCT.',
    passes: ['DistinctElimination'],
    sql: `SELECT DISTINCT C_CUSTKEY, C_NAME
FROM CUSTOMER`,
  },
  {
    name: 'Empty propagation',
    teaches: 'WHERE 1 = 0 can never match, so the filter becomes an Empty node and the estimate drops to zero. The join and scans stay in the tree — Empty keeps a child only to borrow its column types — but nothing below it ever runs.',
    passes: ['ExpressionSimplifier', 'EmptyPropagation'],
    sql: `SELECT c.C_NAME, o.O_TOTALPRICE
FROM CUSTOMER c
  JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE 1 = 0`,
  },
  {
    name: 'Shared CTE',
    teaches: 'A WITH body is planned as its own subject, not pasted into the main query. Use the picker to switch between them.',
    passes: ['PredicatePushdown'],
    sql: `WITH big_orders AS (
  SELECT O_ORDERKEY, O_CUSTKEY, O_TOTALPRICE
  FROM ORDERS
  WHERE O_TOTALPRICE > 200000
)
SELECT a.O_ORDERKEY, b.O_ORDERKEY
FROM big_orders a
  JOIN big_orders b ON a.O_CUSTKEY = b.O_CUSTKEY
WHERE a.O_ORDERKEY < b.O_ORDERKEY`,
  },
  {
    name: 'Residual OR across a join',
    teaches: 'An OR mixed into a join condition would stop it being hashable. The optimizer splits the equality out to join on, and re-checks the OR afterwards.',
    passes: ['JoinResidualSplit'],
    sql: `SELECT o.O_ORDERKEY, l.L_LINENUMBER
FROM ORDERS o
  JOIN LINEITEM l
    ON l.L_ORDERKEY = o.O_ORDERKEY
   AND (o.O_TOTALPRICE > 100000 OR l.L_QUANTITY > 40)`,
  },
  {
    name: 'TPC-H Q3',
    teaches: 'A real benchmark query, end to end: three tables joined pairwise, a filter pushed onto each one, a group-by and a Top-N.',
    passes: ['PredicatePushdown', 'ProjectionPushdown', 'TopNFusion'],
    sql: `SELECT l.L_ORDERKEY,
  SUM(l.L_EXTENDEDPRICE * (1 - l.L_DISCOUNT)) AS revenue,
  o.O_ORDERDATE, o.O_SHIPPRIORITY
FROM CUSTOMER c
  JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
  JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
WHERE c.C_MKTSEGMENT = 'BUILDING'
  AND o.O_ORDERDATE < DATE '1995-03-15'
  AND l.L_SHIPDATE > DATE '1995-03-15'
GROUP BY l.L_ORDERKEY, o.O_ORDERDATE, o.O_SHIPPRIORITY
ORDER BY revenue DESC, o.O_ORDERDATE
LIMIT 10`,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
