export interface PassNote {
  title: string;
  summary: string;
  why: string;
  trigger: string;
}

export const PASS_NOTES: Readonly<Record<string, PassNote>> = {
  ExpressionSimplifier: {
    title: 'Expression Simplifier',
    summary: 'Folds constant arithmetic, drops tautologies like 1 = 1, and rewrites predicates into a canonical shape.',
    why: 'Every later pass pattern-matches on expressions. Cleaning them up first is what lets those passes recognise anything at all.',
    trigger: "WHERE 1 = 1 AND x > 2 + 3",
  },
  SubqueryUnnesting: {
    title: 'Subquery Unnesting',
    summary: 'Turns EXISTS, IN, and scalar subqueries into semi, anti, mark, or single joins — and correlated ones into dependent joins that get decorrelated.',
    why: 'A correlated subquery evaluated per row is a nested loop in disguise. As a join it can be hashed, reordered, and costed.',
    trigger: 'WHERE EXISTS (SELECT 1 FROM ORDERS WHERE O_CUSTKEY = C_CUSTKEY)',
  },
  HavingPushdown: {
    title: 'Having Pushdown',
    summary: 'Splits a HAVING clause: parts referencing only grouping keys move below the aggregate, the rest stay above it.',
    why: 'A predicate on a grouping key filters rows before they are grouped, so the hash table stays small.',
    trigger: 'GROUP BY C_MKTSEGMENT HAVING C_MKTSEGMENT = \'BUILDING\' AND COUNT(*) > 5',
  },
  CTEOptimization: {
    title: 'CTE Optimization',
    summary: 'Counts references to each CTE anchor: one used once is inlined into its consumer, one used many times is materialized.',
    why: 'Inlining exposes the CTE body to pushdown and reordering. Materializing avoids recomputing a shared subplan.',
    trigger: 'Anchors introduced by subquery decorrelation. A plain WITH clause is planned as its own subject instead, so this pass stays idle for it.',
  },
  PredicatePushdown: {
    title: 'Predicate Pushdown',
    summary: 'Moves filters as far down the tree as they can legally go — through projections, into join inputs, onto scans.',
    why: 'The single biggest win in the pipeline. Filtering early shrinks every intermediate result above it.',
    trigger: "FROM CUSTOMER c JOIN ORDERS o ON ... WHERE c.C_NAME = 'x'",
  },
  PredicateInference: {
    title: 'Predicate Inference',
    summary: 'Derives new predicates from existing ones: equality transitivity across join keys, IN lists and ranges factored out of OR branches.',
    why: 'a = b AND a < 10 implies b < 10. The derived predicate can be pushed to the other side of the join, which the original could not.',
    trigger: 'ON a.K = b.K WHERE a.K = 42',
  },
  OuterToInnerJoin: {
    title: 'Outer To Inner Join',
    summary: 'Downgrades an outer join to an inner join when a predicate above it rejects the NULL-extended rows anyway.',
    why: 'Inner joins can be reordered and have both build sides available; outer joins are pinned in place.',
    trigger: 'LEFT JOIN ORDERS o ON ... WHERE o.O_TOTALPRICE > 100',
  },
  AggregatePushdown: {
    title: 'Aggregate Pushdown',
    summary: 'Eager aggregation: splits a decomposable aggregate (SUM, COUNT, MIN, MAX) into a partial below an inner join, grouped by the group-by keys plus the join keys, and a final one above.',
    why: 'Pre-aggregating one join input can shrink it before the join sees it. Whether that pays depends on how far the grouping collapses rows and whether the join was already filtering them away, so the pass costs both plans through the physical planner and keeps the rewrite only if it is genuinely cheaper — on TPC-H it never is.',
    trigger: 'SELECT l.L_ORDERKEY, SUM(l.L_QUANTITY) FROM LINEITEM l JOIN ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY GROUP BY l.L_ORDERKEY',
  },
  JoinReorder: {
    title: 'Join Reorder',
    summary: 'Enumerates join orders over the join hypergraph (DPhyp, falling back to greedy on large graphs) and keeps the cheapest.',
    why: 'Join order decides intermediate cardinality, and intermediate cardinality decides runtime. This is where table statistics earn their keep. The percentage beside this row is a second opinion: the pass chooses with its own cost model over the join graph, while the bar re-prices the finished plan through the physical planner. When the tree visibly moves and the bar still reads 0%, the two models simply agree on the price.',
    trigger: 'A three-table or larger join where one table is far more selective',
  },
  JoinElimination: {
    title: 'Join Elimination',
    summary: 'Drops a left join entirely when the right side is joined on a unique key and none of its columns are used above.',
    why: 'A join that cannot change the row count and produces no consumed column is pure overhead — common in generated SQL and views.',
    trigger: 'LEFT JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY, selecting only ORDERS columns',
  },
  DistinctElimination: {
    title: 'Distinct Elimination',
    summary: 'Removes DISTINCT when the input already provably produces distinct rows, for example when it carries a primary key.',
    why: 'Deduplication needs a hash table over the whole input. Proving it redundant deletes that cost outright.',
    trigger: 'SELECT DISTINCT C_CUSTKEY FROM CUSTOMER',
  },
  ProjectionPushdown: {
    title: 'Projection Pushdown',
    summary: 'Walks the tree collecting the columns each node actually needs, then prunes scans and projections down to that set.',
    why: 'A columnar scan only pays for the columns it reads. Pruning early cuts I/O and shrinks every row that flows upward.',
    trigger: 'SELECT C_NAME FROM CUSTOMER — the other seven columns never need to be read',
  },
  LimitPushdown: {
    title: 'Limit Pushdown',
    summary: 'Pushes LIMIT below projections, into both branches of a UNION ALL, and onto a Sort as a bounded sort.',
    why: 'A sort that only has to keep the top N rows becomes a bounded heap instead of a full sort.',
    trigger: 'ORDER BY O_TOTALPRICE DESC LIMIT 10',
  },
  EmptyPropagation: {
    title: 'Empty Propagation',
    summary: 'Recognises provably empty inputs and collapses the operators above them into an empty result.',
    why: 'The cheapest plan for a query that returns nothing is one that reads nothing.',
    trigger: 'WHERE 1 = 0',
  },
  NodeMerge: {
    title: 'Node Merge',
    summary: 'Collapses adjacent same-kind operators: two stacked Filters become one AND, a redundant Project over an identical Project disappears.',
    why: 'Earlier passes leave debris behind. Merging it removes a whole operator from the runtime pipeline.',
    trigger: 'Any plan where pushdown left two filters stacked on one another',
  },
  PredicateDedup: {
    title: 'Predicate Dedup',
    summary: 'Drops duplicate conjuncts inside a single predicate, comparing expressions structurally rather than by identity.',
    why: 'Inference and pushdown both derive predicates, so the same test can arrive twice. Evaluating it twice is wasted work per row.',
    trigger: 'A predicate that inference re-derived from a join equality',
  },
  FilterOrdering: {
    title: 'Filter Ordering',
    summary: 'Reorders the conjuncts of a filter so the cheapest and most selective tests run first.',
    why: 'AND short-circuits. Putting the test that rejects the most rows first means the expensive tests run on far fewer rows.',
    trigger: "WHERE C_COMMENT LIKE '%foo%' AND C_MKTSEGMENT = 'BUILDING'",
  },
  IndexSelection: {
    title: 'Index Selection',
    summary: 'Converts a filter over a scan into an index scan when an index covers the predicate columns and the estimated selectivity justifies it.',
    why: 'A selective point or range lookup should touch a few pages, not the whole table. Selectivity is what decides between the two.',
    trigger: 'WHERE O_ORDERKEY = 42, with an index on O_ORDERKEY',
  },
  JoinResidualSplit: {
    title: 'Join Residual Split',
    summary: 'Separates a join condition into equi-join conjuncts and a residual filter above the join, for OR predicates spanning both sides.',
    why: 'A join keeps only the part it can hash on. Leaving a cross-side OR inside the condition would force a nested loop. Expect the estimate to tick up rather than down: the cost model prices the plan it is handed as a hash join either way, so it charges for the new Filter without ever charging for the nested loop this pass avoided.',
    trigger: 'ON a.K = b.K AND (a.X > 1 OR b.Y > 1)',
  },
  PlanProperties: {
    title: 'Plan Properties',
    summary: 'Annotates each node with an estimated cardinality and the sort order it provides. Rewrites nothing.',
    why: 'The passes after it — sort elimination, physical operator choice — read these annotations instead of recomputing them.',
    trigger: 'Runs on every query',
  },
  SortElimination: {
    title: 'Sort Elimination',
    summary: 'Removes a Sort whose ordering is already provided by its input, or whose ordering nothing above it observes.',
    why: 'A sort is one of the few operators that must buffer its entire input. Deleting one changes the memory profile of the query.',
    trigger: 'ORDER BY on a column the plan already produces in order, or inside a subquery whose order nobody reads',
  },
  TopNFusion: {
    title: 'Top-N Fusion',
    summary: 'Fuses a Sort directly under a Limit into a single Top-N operator.',
    why: 'Top-N keeps a bounded heap of N rows instead of materialising and sorting the whole input.',
    trigger: 'ORDER BY O_TOTALPRICE DESC LIMIT 10',
  },
  ScanPruning: {
    title: 'Scan Pruning',
    summary: 'Attaches the filter sitting directly over a scan to the scan itself as a pruning filter.',
    why: 'The scan can then skip whole row groups using zone maps, never decoding the pages it can prove hold no match.',
    trigger: "A filter that pushdown landed directly on top of a table scan",
  },
};

export const STAGE_NOTES: Readonly<Record<string, string>> = {
  PredicateOptimization:
    'A fixpoint stage: pushdown, inference and outer-to-inner run in a loop until the plan stops changing. '
    + 'They feed each other — inference derives a predicate, pushdown moves it down, the move enables another inference — '
    + 'so one pass over them is not enough.',
};

export function noteFor(pass: string): PassNote | null {
  return PASS_NOTES[pass] ?? null;
}
