export interface Example {
  name: string;
  teaches: string;
  passes: readonly string[];
  sql: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    name: 'Pushdown and Top-N',
    teaches: 'ExpressionSimplifier, PredicatePushdown, TopNFusion',
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
    teaches: 'JoinReorder driven by statistics: raise the NATION row count and it moves to the other end of the join tree',
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
    teaches: 'PredicateInference, then PredicatePushdown moving the derived predicate',
    passes: ['PredicateInference', 'PredicatePushdown'],
    sql: `SELECT o.O_ORDERKEY, l.L_QUANTITY
FROM ORDERS o
  JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
WHERE o.O_ORDERKEY = 42`,
  },
  {
    name: 'Correlated EXISTS',
    teaches: 'SubqueryUnnesting turning a correlated subquery into a semi join',
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
    teaches: 'OuterToInnerJoin: both predicates reject NULLs, so the FULL JOIN becomes an INNER JOIN',
    passes: ['OuterToInnerJoin', 'PredicatePushdown'],
    sql: `SELECT c.C_NAME, o.O_TOTALPRICE
FROM CUSTOMER c
  FULL JOIN ORDERS o ON o.O_CUSTKEY = c.C_CUSTKEY
WHERE o.O_TOTALPRICE > 50000 AND c.C_ACCTBAL > 0`,
  },
  {
    name: 'Aggregate and having',
    teaches: 'HavingPushdown, ProjectionPushdown',
    passes: ['HavingPushdown', 'ProjectionPushdown'],
    sql: `SELECT o.O_ORDERSTATUS, SUM(l.L_EXTENDEDPRICE) AS revenue
FROM ORDERS o
  JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY
GROUP BY o.O_ORDERSTATUS
HAVING o.O_ORDERSTATUS = 'F' AND SUM(l.L_EXTENDEDPRICE) > 1000`,
  },
  {
    name: 'Index selection',
    teaches: 'IndexSelection converting a selective filter into an index scan',
    passes: ['IndexSelection'],
    sql: `SELECT O_ORDERKEY, O_TOTALPRICE
FROM ORDERS
WHERE O_ORDERKEY = 42`,
  },
  {
    name: 'Distinct elimination',
    teaches: 'DistinctElimination proving the key already makes rows unique',
    passes: ['DistinctElimination'],
    sql: `SELECT DISTINCT C_CUSTKEY, C_NAME
FROM CUSTOMER`,
  },
  {
    name: 'Empty propagation',
    teaches: 'ExpressionSimplifier, EmptyPropagation collapsing the whole plan',
    passes: ['ExpressionSimplifier', 'EmptyPropagation'],
    sql: `SELECT c.C_NAME, o.O_TOTALPRICE
FROM CUSTOMER c
  JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE 1 = 0`,
  },
  {
    name: 'Shared CTE',
    teaches: 'A CTE body is planned and optimized as its own subject, separate from the query that scans it',
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
    teaches: 'JoinResidualSplit keeping the equi-join hashable',
    passes: ['JoinResidualSplit'],
    sql: `SELECT o.O_ORDERKEY, l.L_LINENUMBER
FROM ORDERS o
  JOIN LINEITEM l
    ON l.L_ORDERKEY = o.O_ORDERKEY
   AND (o.O_TOTALPRICE > 100000 OR l.L_QUANTITY > 40)`,
  },
  {
    name: 'TPC-H Q3',
    teaches: 'The whole pipeline on a real benchmark query',
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
