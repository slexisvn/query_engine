# 19. Projection, limit, and the cleanup passes

> After this chapter you will be able to explain why a query with an impossible `WHERE` clause still returns a row, and name the two optimizer passes whose work the plan printer does not show you.

## The question

This query cannot match anything:

```sql
SELECT COUNT(*) FROM CUSTOMER WHERE 1 = 0
```

It returns one row containing `0`. Add a `GROUP BY` and it returns no rows at all:

```sql
SELECT C_NAME, COUNT(*) FROM CUSTOMER WHERE 1 = 0 GROUP BY C_NAME
```

Both facts are SQL-standard and both are usually taught as rules. In this engine they are the output of a four-line branch in one pass, and the plans show the difference directly.

Ungrouped:

```
-> Project (COUNT_STAR())
  -> Aggregate (aggs: COUNT_STAR())
    -> Empty (short-circuit)
      -> Seq Scan on CUSTOMER as CUSTOMER
```

Grouped:

```
-> Empty (short-circuit)
  -> Seq Scan on CUSTOMER as CUSTOMER
```

The `Empty` node climbed straight through the aggregate and the projection in the second plan, and stopped dead under the aggregate in the first. This chapter is about the five passes that trim a plan rather than restructure it — and about why two of them appear to do nothing.

## Empty propagation

[`ExpressionSimplifier`](../../src/optimizer/passes/expression-simplifier.ts) created the `Empty` node in chapter 16 by folding `1 = 0` to `false`. It left the scan attached as a child, marking the subtree as dead rather than deleting it. [`EmptyPropagation`](../../src/optimizer/passes/empty-propagation.ts) is what moves the mark upward.

Its default rule is one sentence: a node with a single child that is `Empty` becomes that `Empty`. And then the exception:

```typescript
if (children && children.length === 1 && children[0].type === PlanNodeType.EMPTY) {
  if (newNode.type === PlanNodeType.AGGREGATE && (!newNode.groupBy || newNode.groupBy.length === 0)) {
    return newNode;
  }
  return children[0];
}
```

An aggregate with no grouping keys is one group whether or not any rows arrive, so `COUNT(*)` over nothing is `0` and `SUM(x)` over nothing is `NULL` — a row either way. An aggregate *with* grouping keys produces one row per distinct key value, and zero rows have zero distinct values. Those cases explain why empty-input handling must distinguish grouped from ungrouped aggregation.

The join rules follow the same reasoning about which side is allowed to vanish:

| Join type | Empty side | Result |
|---|---|---|
| `INNER`, `CROSS` | either | `Empty` |
| `LEFT` | left | `Empty` |
| `LEFT` | right | join unchanged |
| `FULL` | both | `Empty` |

A `LEFT` join with an empty right input still emits every left row, padded — so it stays. A `LEFT` join with an empty left input emits nothing.

Set operations get a third behavior: if one side is empty, the *other side is returned in its place*, dissolving the set operation entirely. Both empty, and the whole thing is `Empty`.

`EmptyPropagation` also creates `Empty` nodes of its own, for two cases the simplifier does not see: a `Filter` whose condition is the literal `false` (which can arrive after other passes have moved things around) and `LIMIT 0`:

```
SELECT C_NAME FROM CUSTOMER LIMIT 0

  before: -> Limit (count: 0)
            -> Project (CUSTOMER.C_NAME)
              -> Seq Scan on CUSTOMER as CUSTOMER
  after:  -> Empty (short-circuit)
            -> Project (CUSTOMER.C_NAME)
              -> Seq Scan on CUSTOMER as CUSTOMER
```

## Projection pushdown, which the printer hides

Now the first of the two invisible passes. Run [`ProjectionPushdown`](../../src/optimizer/passes/projection-pushdown.ts) on a join query and `formatPlan` prints the identical tree before and after. Look at the scan nodes' column lists instead:

```
SELECT c.C_NAME FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY

before: C: C_CUSTKEY, C_NAME, C_MKTSEGMENT, C_NATIONKEY | O: O_ORDERKEY, O_CUSTKEY, O_TOTALPRICE, O_ORDERSTATUS
after:  C: C_CUSTKEY, C_NAME                            | O: O_CUSTKEY
```

Eight columns became three, and none of it appears in `EXPLAIN` — [`formatNode`](../../src/planner/plan-formatter.ts) prints `Seq Scan on CUSTOMER as C` and nothing about which columns.

That list is not decorative. [`buildScan`](../../src/execution/builders/source-builders.ts) turns `node.columns` into the `projectedColumns` array handed to [`ScanOperator`](../../src/execution/operators/scan.ts), which calls `chunk.project` on every chunk it reads. Columns dropped here are columns the executor never materializes.

The pass is a [`PlanRewriter`](../../src/planner/plan-rewriter.ts) carrying a context: the set of column references its parent still needs. [`ColumnPruner`](../../src/optimizer/passes/projection-pushdown.ts) starts at the root with `null`, meaning *everything*, and each node narrows it on the way down:

- `Project` keeps only the expressions its parent asked for, then passes down the columns those expressions reference.
- `Filter` passes its parent's set plus the columns in its condition.
- `Join` adds the columns in its condition, then splits the set by which side each reference belongs to, using [`collectPlanRefs`](../../src/optimizer/passes/plan-refs.ts).
- `Aggregate` *replaces* the incoming set with the columns in its grouping keys and aggregate arguments — nothing above an aggregate can reference a column that is not one of those.
- `Scan` keeps the columns that survived.

On the book's running query the two aggregate inputs and the filter column survive:

```
before: C: C_CUSTKEY, C_NAME, C_MKTSEGMENT, C_NATIONKEY | O: O_ORDERKEY, O_CUSTKEY, O_TOTALPRICE, O_ORDERSTATUS
after:  C: C_CUSTKEY, C_NAME, C_MKTSEGMENT              | O: O_CUSTKEY, O_TOTALPRICE
```

Three node types deliberately opt out by passing `null` down: [`rewriteSetOp`](../../src/optimizer/passes/projection-pushdown.ts), `rewriteCTEAnchor`, and `rewriteDistinct`. Each has a reason. A set operation matches its inputs positionally, so pruning one side would misalign them. `DISTINCT` is defined over all of its input's columns, so removing one changes which rows are duplicates. A CTE has consumers this walk cannot see.

There is one case where the pass does less than you would expect:

```
SELECT COUNT(*) FROM CUSTOMER
before: CUSTOMER: C_CUSTKEY, C_NAME, C_MKTSEGMENT, C_NATIONKEY
after:  CUSTOMER: C_CUSTKEY, C_NAME, C_MKTSEGMENT, C_NATIONKEY
```

The query that needs no columns at all keeps all four. `COUNT(*)` has no arguments and there are no grouping keys, so `pruneAggregate` builds an empty required-set, and [`pruneScan`](../../src/optimizer/passes/projection-pushdown.ts) opens with:

```typescript
if (!required || required.size === 0) return node;
```

An empty set means "no constraint", not "no columns". The two are conflated, and the result is that the cheapest possible query reads the widest possible rows.

## Limit pushdown

[`LimitPushdown`](../../src/optimizer/passes/limit-pushdown.ts) moves a `Limit` below the node beneath it when doing so is sound, dispatching on that node's type.

Below a `Project`, always — a projection is one row in, one row out:

```
before: -> Limit (count: 10)          after: -> Project (CUSTOMER.C_NAME)
          -> Project (CUSTOMER.C_NAME)         -> Limit (count: 10)
            -> Seq Scan on CUSTOMER              -> Seq Scan on CUSTOMER
```

The rewritten `Limit` is then re-visited, so a chain of projections is traversed in one go.

Into both branches of a `UNION ALL`, with the count raised by the offset — either branch could supply all the rows, so each needs `count + offset` available.

Onto a `Sort`, not as a node but as a field: `{ ...child, limit: node.count + (node.offset || 0), offset: 0 }`. That field is what [`selectsRows`](../../src/planner/sort-properties.ts) reads in chapter 21 to decide whether a sort may be deleted.

Onto a grouped `Aggregate`, as `_limitHint` — an underscore-prefixed annotation, which [chapter 15](15-passes-and-fixpoints.md) showed is invisible to `planSignature` and therefore never counts as a change.

Note which cases are absent. Nothing pushes a limit through a `Filter` (a filter can discard rows, so ten rows in does not mean ten rows out) or through a join, and `UNION` without `ALL` is excluded because deduplication happens above.

## Node merge

[`NodeMerge`](../../src/optimizer/passes/node-merge.ts) collapses adjacent nodes of the same kind. Three cases.

Two stacked `Filter`s become one with the conditions `AND`ed. Two stacked `Limit`s become one, and the arithmetic is the interesting part:

```typescript
const available = Math.max(0, child.count - nodeOffset);
const mergedCount = Math.min(node.count, available);
return { ...node, count: mergedCount, offset: childOffset + nodeOffset, children: [child.children[0]] };
```

Offsets add; the count is the outer count clamped to what remains of the inner one after skipping.

Two stacked `Project`s merge only if their expression lists are equal, compared by [`exprEqualsIgnoringOutput`](../../src/optimizer/passes/node-merge.ts), a structural comparison that skips the `outputName` and `alias` keys. Duplicated projections like that come from subqueries:

```
SELECT * FROM (SELECT C_NAME FROM CUSTOMER LIMIT 100) t LIMIT 10

before: -> Limit (count: 10)          after: -> Limit (count: 10)
          -> Project (T.C_NAME)                -> Project (T.C_NAME)
            -> Project (T.C_NAME)                -> Limit (count: 100)
              -> Limit (count: 100)                -> Project (CUSTOMER.C_NAME)
```

Merging identical projections is safe only because they *are* identical. A projection that renames or reorders is not a no-op, and the equality test is what distinguishes them.

## Predicate dedup

[`PredicateDedup`](../../src/optimizer/passes/predicate-dedup.ts) splits every filter condition and every join condition into conjuncts, keys them, and keeps the first of each key. Its local [`exprKey`](../../src/optimizer/passes/predicate-dedup.ts) wraps the canonical one with a commutativity rule:

```typescript
const COMMUTATIVE_OPS: ReadonlySet<string> = new Set(['=', '<>', 'AND', 'OR', '+', '*']);

function exprKey(expr: BoundExpr | null): string {
  if (expr && expr.kind === BoundExprKind.BINARY && COMMUTATIVE_OPS.has(expr.op)) {
    const [first, second] = left < right ? [left, right] : [right, left];
    return `bin(${expr.op},${first},${second})`;
  }
  return canonicalExprKey(expr);
}
```

So operands of commutative operators are sorted before keying, and these two conjuncts collapse into one:

```
WHERE C_CUSTKEY = 5 AND 5 = C_CUSTKEY
  -> Filter (condition: (CUSTOMER.C_CUSTKEY = 5))
```

Nobody writes that. The pass exists for what the optimizer writes: chapter 15 traced a query where the predicate fixpoint diverges and deposits one fresh copy of the same conjunct per iteration — eight identical predicates on one scan — and this is the pass that turns them back into one. Registering it early would not help, because the duplicates are produced by a stage that has already finished.

If dedup empties a filter's conjunct list entirely, the filter is dropped; if it empties a join's, the join's condition becomes `null`, which makes it a cross join.

## The two invisible passes

Run the observer on the book's running query and compare plans with `formatPlan`: three of the 27 pass invocations changed something. Compare with [`planSignature`](../../src/optimizer/plan-signature.ts) instead and it is five.

The two extra are `ProjectionPushdown`, which rewrote scan column lists, and `ScanPruning` from [chapter 21](21-access-paths-and-orderings.md), which attached a `pruningFilter` to a scan. Both are real changes to the plan the executor receives. Neither is printed.

This is worth knowing before you debug a pass. **The formatter is a lossy view**, as chapter 13 said, and "the plan did not change" is a claim about the string, not about the tree. When a pass appears to do nothing, compare signatures before concluding anything.

## In the code

| Idea | Where |
|---|---|
| Empty marking and propagation | [`EmptyPropagation`](../../src/optimizer/passes/empty-propagation.ts) |
| Column pruning | [`ProjectionPushdown`](../../src/optimizer/passes/projection-pushdown.ts), [`ColumnPruner`](../../src/optimizer/passes/projection-pushdown.ts) |
| Scan column filter | [`pruneScan`](../../src/optimizer/passes/projection-pushdown.ts) |
| Limit movement | [`LimitPushdown`](../../src/optimizer/passes/limit-pushdown.ts) |
| Adjacent-node collapsing | [`NodeMerge`](../../src/optimizer/passes/node-merge.ts) |
| Structural expression equality | [`exprEqualsIgnoringOutput`](../../src/optimizer/passes/node-merge.ts) |
| Conjunct deduplication | [`PredicateDedup`](../../src/optimizer/passes/predicate-dedup.ts) |
| Which columns a subtree exposes | [`collectPlanRefs`](../../src/optimizer/passes/plan-refs.ts) |

## Traps

**`Empty` keeps its child.** `Empty (short-circuit)` printed above a `Seq Scan` does not mean the scan runs. The child is retained so the node still carries a schema, and the executor never pulls from it. Reading the plan as if the subtree were live is the most common misreading of this node.

**Projection pushdown will not prune for `COUNT(*)`.** An empty required-column set is treated as no information at all.

**`ProjectionPushdown` runs once, after join reordering.** A join order chosen with all columns present is not re-costed after pruning, so the width saving does not feed back into the cost model.

**`LimitPushdown` writes `limit` onto a `Sort` node and the printer does not show it.** `Sort (SUM(O.O_TOTALPRICE) DESC)` may or may not be limited; only `TopNFusion` later turns that into a visible `Top-N`.

**Merging two `Limit`s clamps rather than sums the counts.** `LIMIT 10` over `LIMIT 100` is 10 rows, not 110; `LIMIT 10 OFFSET 95` over `LIMIT 100` is 5. If the arithmetic looks surprising, work through `available` before assuming it is wrong.

## Exercises

### Understand

What should COUNT(*) and SUM(x) return on an empty input with no GROUP BY? What changes with GROUP BY k?

### Practice

1. **Observe.** Reproduce the two `Empty` plans. Then predict what happens to `SELECT SUM(C_CUSTKEY) FROM CUSTOMER WHERE 1 = 0` and what value the row contains, and check both.

2. **Observe.** Write a helper that walks a plan and prints each scan's alias and column names. Use it to reproduce the pruning table for the running query, then find a query where projection pushdown prunes nothing and explain why.

3. **Extend (optional).** Fix the `COUNT(*)` case. `pruneScan` needs to distinguish "no constraint" from "no columns needed". Note that its existing guard, `neededCols.length > 0 && neededCols.length < node.columns.length`, already refuses to produce a zero-column scan — decide what the scan should keep instead, and run the tests.

4. **Extend (optional).** Delete `PredicateDedup` from the pipeline, then optimize the divergent query from chapter 15 and count conjuncts. Then set `QE_OPTIMIZER_FIXPOINT_ITERATIONS=32` and count again.

5. **Extend (optional).** Extend `NodeMerge` to collapse a `Project` whose expressions are a strict subset of its child's, in the same order. Write down the case where that is unsound before you write the code.

### Hints and expected observations

The ungrouped result has one row: count 0 and sum NULL. With grouping keys there are no groups and therefore no output rows.

## Recap

- An `Empty` node **marks** a dead subtree; [`EmptyPropagation`](../../src/optimizer/passes/empty-propagation.ts) moves the mark up. It refuses to pass through an **ungrouped aggregate**, which is why `SELECT COUNT(*) ... WHERE 1 = 0` returns one row and the grouped version returns none.
- [`ProjectionPushdown`](../../src/optimizer/passes/projection-pushdown.ts) carries a **required-column set** down the tree and trims each scan's column list. Aggregates reset the set; set operations, `DISTINCT`, and CTE anchors opt out.
- An empty required set means "no constraint", so **`COUNT(*)` prunes nothing**.
- [`LimitPushdown`](../../src/optimizer/passes/limit-pushdown.ts) moves limits below projections and into `UNION ALL` branches, and turns them into a `limit` field on a `Sort` or a `_limitHint` on an aggregate.
- [`NodeMerge`](../../src/optimizer/passes/node-merge.ts) collapses adjacent filters, adjacent limits (clamping, not summing), and adjacent **identical** projections.
- [`PredicateDedup`](../../src/optimizer/passes/predicate-dedup.ts) removes duplicate conjuncts, treating commutative operators as unordered. It exists mostly to clean up after the predicate fixpoint.
- Two of these passes are **invisible to `formatPlan`**. Compare `planSignature` when you need to know whether a pass did anything.

Next: [chapter 20](20-eliminating-work.md) moves from trimming the plan to deleting whole operators — joins that need not happen and `DISTINCT`s that are already guaranteed.
