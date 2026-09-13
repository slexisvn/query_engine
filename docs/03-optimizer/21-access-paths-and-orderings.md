# 21. Access paths and orderings

> After this chapter you will be able to explain how a `Sort` node disappears from a plan without anything sorting, and say which of this engine's access-path optimizations are live and which are waiting for a feature the SQL grammar does not have.

## The question

Here is a query with an explicit `ORDER BY`, over a `CUSTOMER` table of 200 rows:

```sql
SELECT C_NAME FROM CUSTOMER WHERE C_CUSTKEY > 190 ORDER BY C_CUSTKEY
```

Given a B-tree index on `C_CUSTKEY`, the optimizer produces this:

```
-> Project (CUSTOMER.C_NAME)
  -> Index Scan using IDX_CUSTOMER_C_CUSTKEY on CUSTOMER (range: 190 to ∞)
```

Both the `Filter` and the `Sort` are gone. The filter becoming a range on the index scan is unsurprising once you see it. The sort vanishing is the interesting part, because nothing in that plan sorts anything — and the rows still come out in `C_CUSTKEY` order.

Change `190` to `10` and the whole plan reverts: filter, sequential scan, and a sort.

Four passes cooperated to produce the first plan, and none of them knows about the others. They communicate through two fields on the plan node and one number from the statistics.

## Access paths

An **access path** is how an operator gets at a table's rows. This engine has two: a sequential scan and an index scan.

[`IndexSelection`](../../src/optimizer/passes/index-selection.ts) considers replacing a `Filter` directly above a `Scan` with an index scan. [`_analyzeConjunct`](../../src/optimizer/passes/index-selection.ts) recognizes `column op literal` and `literal op column` for the five comparison operators, normalizing the flipped form (`42 > x` becomes `x < 42`); anything else is set aside as unindexable.

Recognized conjuncts are grouped by column into a `ColumnBounds` record holding an equality point, a low bound, and a high bound. The pass walks those columns, asks the catalog for an index on each, and takes the first one it can use. An equality gives a point lookup; bounds give a range:

```
WHERE C_CUSTKEY = 42
  -> Index Scan using IDX_CUSTOMER_C_CUSTKEY on CUSTOMER (key: 42)
```

Conjuncts that did not contribute to the chosen index become a residual filter above the index scan:

```
WHERE C_CUSTKEY > 10 AND C_CUSTKEY < 20 AND C_MKTSEGMENT = 'BUILDING'

-> Project (CUSTOMER.C_NAME)
  -> Filter (condition: (CUSTOMER.C_MKTSEGMENT = 'BUILDING'))
    -> Index Scan using IDX_CUSTOMER_C_CUSTKEY on CUSTOMER (range: 10 to 20)
```

Both `C_CUSTKEY` conjuncts folded into the range; the segment predicate stayed behind. That split — `indexedIndices` versus `residualConjuncts` — is the whole of the pass's output shape.

When statistics are available, an index is rejected if it would not be selective enough. Two words in that sentence are about to become numbers, so pin them down first.

The **selectivity** of a predicate is the fraction of rows it keeps: 1.0 means everything survives, 0.01 means one row in a hundred. It is an estimate, computed from the statistics [chapter 22](22-statistics.md) collects, and [chapter 23](23-cardinality-estimation.md) is entirely about how each kind of predicate gets one. **`ndv`** is the number of distinct values a column holds — 200 for a key with 200 different values, 3 for a market-segment column with three. If the values were spread evenly, an equality on that column would keep one row in `ndv`, which is where the first line below comes from.

```typescript
if (bounds.point !== null) {
  selectivity = 1 / ndv;
} else {
  selectivity = this._estimateRangeSelectivity(colStats, bounds);
}
if (selectivity > Config.indexScanSelectivityThreshold) continue;
```

`indexScanSelectivityThreshold` is 0.3. An equality on a column with three distinct values estimates 1/3 selectivity and is refused, because reading a third of the table through an index — one row at a time, following pointers — is slower than reading all of it sequentially. [`_estimateRangeSelectivity`](../../src/optimizer/passes/index-selection.ts) computes the range's share of the column's min-to-max span, defaulting to 0.33 when the bounds are not numeric.

This is the second half of the opening question. On this table `C_CUSTKEY` has `ndv=200`, `min=1`, `max=200`. `C_CUSTKEY > 190` covers ten of a span of 199, an estimated selectivity of about 0.05, and the index is taken. `C_CUSTKEY > 10` covers 190 of 199 — about 0.955 — and the index is refused:

```
SELECT C_NAME FROM CUSTOMER WHERE C_CUSTKEY > 10 ORDER BY C_CUSTKEY

without statistics                            with statistics
-> Project (CUSTOMER.C_NAME)                  -> Project (CUSTOMER.C_NAME)
  -> Index Scan using                           -> Sort (CUSTOMER.C_CUSTKEY ASC)
       IDX_CUSTOMER_C_CUSTKEY on CUSTOMER         -> Filter (condition:
       (range: 10 to ∞)                                (CUSTOMER.C_CUSTKEY > 10))
                                                    -> Seq Scan on CUSTOMER as CUSTOMER
```

Two things follow. The gate only exists once statistics have been collected — the whole check sits inside `if (this.statistics)` — so an engine that has not yet run a query takes every index it can find. And the sort's fate is settled by a pass three registrations later that knows nothing about indexes: it disappears when the access path happens to supply the ordering, and stays when it does not.

### Where the indexes come from

The pass is written, reachable, and registered. It also never fires on a table you created with SQL, and the reason is worth stating plainly.

`catalog.indexes` starts empty. The only code in `src/` that populates it is [`buildIndexes`](../../src/engine/query-engine.ts), which builds a [`BTreeIndex`](../../src/storage/btree.ts) over each primary-key column by scanning every page. Nothing calls it — not the CLI, not `compile`, not `run`. And as [chapter 20](20-eliminating-work.md) established, [`parseCreateTable`](../../src/parser/parser.ts) has no `PRIMARY KEY` syntax, so a SQL-created table has no primary key to index in the first place.

To get the plans in this section you have to do both halves yourself:

```javascript
engine.catalog.registerTable('CUSTOMER', columns, { primaryKey: ['C_CUSTKEY'] });
engine.catalog.registerIndex('CUSTOMER', 'C_CUSTKEY', new BTreeIndex(DataType.INT32));
```

So: index selection works, and the default path has nothing for it to select. Treat every index scan in this chapter as a demonstration of a mechanism rather than of something that will happen to your query.

## Scan pruning, which the printer also hides

[`ScanPruning`](../../src/optimizer/passes/scan-pruning.ts) is twenty-three lines and the last pass in the pipeline. It finds a `Filter` directly above a `Scan` and copies the condition onto the scan node, leaving the filter exactly where it was:

```typescript
const scan: LogicalScanNode = { ...child, pruningFilter: node.condition };
return { ...node, children: [scan] };
```

Nothing about the plan's printed shape changes, because `pruningFilter` is not a field `formatNode` prints. Inspect the scan node directly and it is there:

```
scan.pruningFilter = (CUSTOMER.C_MKTSEGMENT = 'BUILDING')
```

This is the second of the two passes [chapter 19](19-projection-limit-and-cleanup.md) identified as invisible to the plan printer. What it feeds is [`buildScan`](../../src/execution/builders/source-builders.ts), which compiles the annotation into a chunk pruner:

```typescript
const pruner = Config.zoneMapPruning
  ? compileChunkPruner(node.pruningFilter ?? null, schemaColumnResolver(schema, alias))
  : null;
```

A **zone map** is a per-chunk summary — minimum and maximum per column — that lets the scan skip whole chunks whose range cannot satisfy the predicate. Chapter 32 covers the mechanism. The filter node is deliberately kept: pruning is approximate, so rows in surviving chunks still have to be checked.

Duplicating the condition rather than moving it is why this pass is last. Any pass that ran after it and rewrote the filter would leave the annotation stale.

## Orderings as a plan property

Now the sort. The engine tracks, for each node, what order its output is already in. That tracking is done by [`PlanProperties`](../../src/optimizer/passes/plan-properties.ts), a pass whose entire body is:

```typescript
override apply(plan: LogicalPlanNode): LogicalPlanNode {
  return this.annotator.annotate(plan);
}
```

[`PlanPropertiesRewriter`](../../src/planner/plan-properties.ts) walks bottom-up and attaches two underscore-prefixed fields to every node:

```typescript
return {
  ...rewritten,
  _cardinality: this.estimateCardinality(rewritten),
  _sortedBy: inferSortOrder(rewritten),
};
```

[`inferSortOrder`](../../src/planner/sort-properties.ts) is four cases:

| Node | Ordering |
|---|---|
| `Sort`, `TopN` | its own order keys, as `{ key, direction }` pairs |
| `IndexScan` | one entry: the indexed column, ascending |
| `Filter`, `Project`, `Limit` | whatever the child was sorted by |
| anything else | nothing |

The third row is the propagation rule, and it is a claim about the operators: filtering, projecting, and limiting all preserve input order. The second row is the one that makes the opening plan work — a B-tree index is traversed in key order, so an index scan arrives pre-sorted.

Because both fields start with `_`, [`planSignature`](../../src/optimizer/plan-signature.ts) ignores them, and this pass never registers as having changed the plan. [Chapter 15](15-passes-and-fixpoints.md) explains why that convention is load-bearing.

## Deleting sorts

[`SortElimination`](../../src/optimizer/passes/sort-elimination.ts) runs immediately after `PlanProperties` and applies two rewriters in sequence.

**A sort whose input is already sorted correctly.** [`SortEliminationRewriter`](../../src/optimizer/passes/sort-elimination.ts):

```typescript
if (!selectsRows(node) && satisfiesOrder(child._sortedBy, node.orderKeys)) {
  return child;
}
```

[`satisfiesOrder`](../../src/planner/sort-properties.ts) checks the provided ordering against the required one position by position — each required key must be a column reference, must match the provided key at the same index, and must have the same direction. A prefix is enough: a plan sorted by `(a, b)` satisfies a requirement of `(a)`.

[`selectsRows`](../../src/planner/sort-properties.ts) is the guard against a subtle error. `LimitPushdown` in chapter 19 stores a limit *onto* the `Sort` node rather than keeping a separate `Limit`, so a `Sort` can be a top-N in disguise. Deleting it would drop the row limit along with the ordering, so a sort with `limit` or `offset` set is never removed.

Trace the opening query. `PredicatePushdown` moves the filter onto the scan; `IndexSelection` turns filter-plus-scan into an `IndexScan` because `C_CUSTKEY > 190` is selective enough; `PlanProperties` annotates it with `_sortedBy: ['CUSTOMER.C_CUSTKEY']`; `SortElimination` sees the required `ORDER BY C_CUSTKEY ASC` satisfied and returns the child. Four passes, one shared field.

**A sort nobody is looking at.** [`UnobservedSortRewriter`](../../src/optimizer/passes/sort-elimination.ts) walks top-down carrying a boolean, consulting a table of which node types care about their input's order:

```typescript
const CHILD_ORDER_REQUIREMENT: Partial<Record<PlanNodeType, boolean>> = {
  [PlanNodeType.SORT]: ORDER_IGNORED,
  [PlanNodeType.TOP_N]: ORDER_IGNORED,
  [PlanNodeType.AGGREGATE]: ORDER_IGNORED,
  ...
  [PlanNodeType.LIMIT]: ORDER_REQUIRED,
  [PlanNodeType.WINDOW]: ORDER_REQUIRED,
  [PlanNodeType.MERGE_EXCHANGE]: ORDER_REQUIRED,
  [PlanNodeType.CTE_ANCHOR]: ORDER_REQUIRED,
};
```

Node types not in the table inherit their parent's requirement. An aggregate does not care what order its input arrives in, so anything below it that only sorts is dead work:

```
SELECT COUNT(*) FROM (SELECT C_NAME FROM CUSTOMER ORDER BY C_NAME) t

BEFORE                                     AFTER
-> Project (COUNT_STAR())                  -> Project (COUNT_STAR())
  -> Aggregate (aggs: COUNT_STAR())          -> Aggregate (aggs: COUNT_STAR())
    -> Project (CUSTOMER.C_NAME)               -> Project (CUSTOMER.C_NAME)
      -> Sort (CUSTOMER.C_NAME ASC)              -> Seq Scan on CUSTOMER as CUSTOMER
        -> Seq Scan on CUSTOMER as CUSTOMER
```

The walk starts with `context?.rootOrderRequired ?? true` — the one field in [`OptimizationContext`](../../src/optimizer/pass.ts), and the only place any pass reads context. It exists for CTEs: [`cteScanOrderRequirements`](../../src/optimizer/passes/sort-elimination.ts) asks whether each CTE's rows are consumed in an order-sensitive position, and [`optimizeCTEMap`](../../src/engine/query-engine.ts) optimizes each CTE body with the answer.

## Fusing sort and limit

[`TopNFusion`](../../src/optimizer/passes/topn-fusion.ts) is the last structural rewrite. A `Limit` over a `Sort` becomes a single `Top-N`:

```
SELECT C_NAME FROM CUSTOMER ORDER BY C_CUSTKEY LIMIT 5

BEFORE                                     AFTER
-> Limit (count: 5)                        -> Project (CUSTOMER.C_NAME)
  -> Project (CUSTOMER.C_NAME)               -> Top-N (count: 5, order: CUSTOMER.C_CUSTKEY ASC)
    -> Sort (CUSTOMER.C_CUSTKEY ASC)           -> Seq Scan on CUSTOMER as CUSTOMER
      -> Seq Scan on CUSTOMER as CUSTOMER
```

Note that the pass handles the `Limit`-over-`Project`-over-`Sort` shape as a second case, reaching through the projection. That shape is exactly what `LimitPushdown` produces, which is why the two passes are registered in that order.

The win is asymptotic: a sort of *n* rows costs *O(n log n)* and holds all *n*, while a top-*k* holds a heap of *k* and costs *O(n log k)*. On the book's running query, `LIMIT 10` over a sort of every customer group becomes a ten-element heap. Chapter 37 covers the operator.

## Ordering conjuncts within a filter

One more small pass belongs here, because it is about how a filter is evaluated rather than where it sits. [`FilterOrdering`](../../src/optimizer/passes/filter-ordering.ts) sorts a filter's conjuncts by estimated selectivity, most selective first:

```typescript
const scored: ScoredPred[] = conjuncts.map((pred) => ({
  pred,
  selectivity: this.cardEstimator.estimateSelectivity(pred),
}));
scored.sort((a, b) => a.selectivity - b.selectivity);
```

```
WHERE C_NATIONKEY > 3 AND C_CUSTKEY = 42

before: Filter (condition: ((CUSTOMER.C_NATIONKEY > 3) AND (CUSTOMER.C_CUSTKEY = 42)))
after:  Filter (condition: ((CUSTOMER.C_CUSTKEY = 42) AND (CUSTOMER.C_NATIONKEY > 3)))
```

The estimator scores them 0.005 and 0.86. Conjunct evaluation short-circuits on the first `false`, so putting the 0.005 first means the 0.86 is evaluated on a two-hundredth of the rows. This is the pass [chapter 17](17-predicate-pushdown.md) pointed at when it noted that pushdown moves predicates without asking whether it is worth it: separating *where* a predicate goes from *in what order* it runs keeps both passes simple. [Chapter 23](23-cardinality-estimation.md) is about where those two numbers come from.

## In the code

| Idea | Where |
|---|---|
| Index scan selection | [`IndexSelection`](../../src/optimizer/passes/index-selection.ts), [`_analyzeConjunct`](../../src/optimizer/passes/index-selection.ts), [`_estimateRangeSelectivity`](../../src/optimizer/passes/index-selection.ts) |
| Index construction (uncalled) | [`buildIndexes`](../../src/engine/query-engine.ts) |
| Zone-map annotation, and its consumer | [`ScanPruning`](../../src/optimizer/passes/scan-pruning.ts), [`buildScan`](../../src/execution/builders/source-builders.ts) |
| Cardinality and ordering annotation | [`PlanProperties`](../../src/optimizer/passes/plan-properties.ts), [`PlanPropertyAnnotator`](../../src/planner/plan-properties.ts) |
| Order inference and satisfaction | [`inferSortOrder`](../../src/planner/sort-properties.ts), [`satisfiesOrder`](../../src/planner/sort-properties.ts) |
| Sort deletion | [`SortElimination`](../../src/optimizer/passes/sort-elimination.ts), [`cteScanOrderRequirements`](../../src/optimizer/passes/sort-elimination.ts) |
| Sort plus limit fusion | [`TopNFusion`](../../src/optimizer/passes/topn-fusion.ts) |
| Conjunct reordering | [`FilterOrdering`](../../src/optimizer/passes/filter-ordering.ts) |

## Traps

**Index selection is dormant by default.** No `PRIMARY KEY` in the grammar, and `buildIndexes` is never called. Every index scan in this chapter required two explicit calls on the catalog.

**The first usable index wins.** The loop over columns `break`s as soon as one passes the selectivity check, so which index is chosen depends on the insertion order of the conjuncts into a `Map`. Candidates are never compared.

**`satisfiesOrder` requires order keys to be column references.** `columnKeyOf` returns `null` for anything else, so `ORDER BY C_CUSTKEY + 0` cannot be satisfied by any ordering — and [chapter 16](16-expression-simplification.md) showed the simplifier does not visit sort keys, so the `+ 0` is still there.

**A `Sort` with a `limit` field is not a sort.** It is a top-N that has not been renamed yet, and `selectsRows` is what stops sort elimination from deleting the limit with it.

**Zone-map pruning is a config flag.** `Config.zoneMapPruning` gates the compiler in `buildScan`; the annotation is attached regardless.

**`ScanPruning` duplicates the predicate rather than moving it.** The `Filter` above the scan still runs on every surviving row. That is required — a zone map can only prove a chunk is *irrelevant*, never that every row in it matches.

## Recap

- An **access path** is how rows are reached. [`IndexSelection`](../../src/optimizer/passes/index-selection.ts) turns a `Filter` over a `Scan` into a point or range `Index Scan`, leaving unindexed conjuncts as a residual filter, and refuses an index whose estimated selectivity exceeds 0.3.
- Index selection is **dormant on the default path**: the grammar cannot declare a primary key and `buildIndexes` is never called.
- [`ScanPruning`](../../src/optimizer/passes/scan-pruning.ts) copies a filter's condition onto the scan as `pruningFilter`, which becomes a **zone-map** chunk pruner at execution. It duplicates rather than moves, and it runs last so nothing invalidates it.
- [`PlanProperties`](../../src/optimizer/passes/plan-properties.ts) annotates every node with `_cardinality` and `_sortedBy`. Sorts and index scans establish an ordering; filters, projections, and limits **propagate** it.
- [`SortElimination`](../../src/optimizer/passes/sort-elimination.ts) deletes a sort whose input already satisfies it, and a sort whose output order **nobody observes** — decided by a per-node-type table and one context flag that exists for CTEs.
- [`TopNFusion`](../../src/optimizer/passes/topn-fusion.ts) merges `Limit` over `Sort` into `Top-N`, turning an *O(n log n)* full sort into an *O(n log k)* heap.
- [`FilterOrdering`](../../src/optimizer/passes/filter-ordering.ts) sorts conjuncts by estimated selectivity so short-circuit evaluation rejects rows as early as possible.

Next: [chapter 22](22-statistics.md) starts the cost-based half of the optimizer with the question every pass in it depends on — how many distinct values does this column have, and how do you find out without reading the table twice?
