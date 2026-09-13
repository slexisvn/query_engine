# 20. Eliminating work entirely

> After this chapter you will be able to check the uniqueness and row-preservation conditions that permit the join eliminations implemented here.

## The question

This query joins two tables:

```sql
SELECT o.O_ORDERKEY
FROM ORDERS o LEFT JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
```

Here is the plan the optimizer produces:

```
-> Project (O.O_ORDERKEY)
  -> Seq Scan on ORDERS as O
```

The join is gone, and so is `CUSTOMER`. Not reordered, not turned into a semi-join — deleted, along with the table it referenced.

That looks like the optimizer discarding part of your query. It is not, and the argument that it is not turns entirely on the fact that `C_CUSTKEY` is `CUSTOMER`'s primary key. Change one thing about the schema and the same rewrite becomes wrong. This chapter is about three passes that delete operators, and about the small module all three of them ask permission from.

## What makes deleting a join legal

A `LEFT JOIN` has one guarantee and one hazard. The guarantee: every left row appears in the output. The hazard: a left row appears *once per match*, so if two customers had key 5, an order with `O_CUSTKEY = 5` would appear twice.

So deleting the join is sound when two things hold at once:

1. **Nothing above the join reads a column from the right side.** Otherwise those columns vanish from the output.
2. **The right side produces at most one row per join key.** Otherwise the left rows are duplicated, and deleting the join changes the row count.

[`JoinElimination`](../../src/optimizer/passes/join-elimination.ts) checks exactly those two things, in that order:

```typescript
if (rightUsed) return child;
if (!preservesLeftCardinality(child, catalog)) return child;
return child.children[0];
```

The pass only looks at a `LEFT` join sitting directly beneath a `Project` or an `Aggregate` — the node types in `COLUMN_RESTRICTING_PARENTS` — because those are the nodes that can narrow the output enough for the right side to become unused.

Both conditions are visible in the plans. Ask for a column from the right and the join stays:

```sql
SELECT o.O_ORDERKEY, c.C_NAME FROM ORDERS o LEFT JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
```

```
-> Project (O.O_ORDERKEY, C.C_NAME)
  -> LEFT Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
    -> Seq Scan on ORDERS as O
    -> Seq Scan on CUSTOMER as C
```

Swap the sides so the right table is `ORDERS`, whose key column in the join is `O_CUSTKEY` rather than its primary key `O_ORDERKEY`, and the join also stays:

```sql
SELECT c.C_CUSTKEY FROM CUSTOMER c LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
```

```
-> Project (C.C_CUSTKEY)
  -> LEFT Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
    -> Seq Scan on CUSTOMER as C
    -> Seq Scan on ORDERS as O
```

Correctly so — a customer with three orders must appear three times, and deleting the join would produce one row.

## The uniqueness module

The second check delegates to [`src/optimizer/unique-keys.ts`](../../src/optimizer/unique-keys.ts), which answers one question for a plan subtree: *given these columns, is at most one row produced per distinct combination?*

[`preservesLeftCardinality`](../../src/optimizer/passes/join-elimination.ts) collects the right-side columns that appear in equality conjuncts of the join condition and hands them over:

```typescript
for (const pred of splitConjuncts(join.condition)) {
  if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') continue;
  for (const side of [pred.left, pred.right]) {
    if (side.kind !== BoundExprKind.COLUMN_REF) continue;
    if (!belongsToRight(side, rightAliases, rightNames)) continue;
    rightKeys.add(columnKey(side.tableAlias, side.columnName));
  }
}

return isUniqueOnKeys(right, rightKeys, catalog);
```

[`isUniqueOnKeys`](../../src/optimizer/unique-keys.ts) recurses on node type, and each case is a small proof:

| Node | Unique on `keys` when |
|---|---|
| `Scan` | the table has a declared primary key and **every** primary-key column is in `keys` |
| `Aggregate` | there are no grouping keys (one row total), or every grouping key is in `keys` |
| `Distinct` | its child is a `Project` whose outputs are all in `keys` |
| `Project` | `keys` translate back through the projection to column references, and the child is unique on those |
| `Filter`, `Sort`, `TopN`, `Limit`, `Materialize` | the child is |
| anything else | never |

Two details are load-bearing. The primary-key rule needs *all* of the key columns, so a two-column primary key with only one column in the join condition does not qualify. And [`translateThroughProject`](../../src/optimizer/unique-keys.ts) returns `null` — meaning "cannot tell" — the moment a projected expression is anything but a bare column reference, so uniqueness does not survive `SELECT C_CUSTKEY + 0 AS K`.

The catalog interface it needs is two lines:

```typescript
export interface UniqueKeyTable { primaryKey: string[]; }
export interface UniqueKeyCatalog { getTable(name: string): UniqueKeyTable | null; }
```

Which raises the point that must be stated plainly: **the SQL grammar this engine accepts has no `PRIMARY KEY` clause.** [`parseCreateTable`](../../src/parser/parser.ts) reads a name and a type per column and nothing else. `primaryKey` is set only through the third argument of [`registerTable`](../../src/catalog/catalog.ts) on the catalog object:

```javascript
engine.catalog.registerTable('CUSTOMER', columns, { primaryKey: ['C_CUSTKEY'] });
```

Every plan in this chapter was produced by doing that first. A table created through SQL has an empty `primaryKey`, `isUniqueOnKeys` returns `false` at the scan case, and neither of the two passes in this section ever fires. That is not a bug in the passes; it is a gap between the grammar and the catalog, and it is worth knowing before you spend an afternoon wondering why your join was not eliminated.

## Distinct elimination

The same module answers a second question, and [`DistinctElimination`](../../src/optimizer/passes/distinct-elimination.ts) is thirty-six lines around it:

```typescript
override rewriteDistinct(node: LogicalDistinctNode): LogicalPlanNode {
  const child: LogicalPlanNode = this.rewrite(node.children[0]);
  if (producesDistinctRows(child, this.catalog)) return child;
  return child === node.children[0] ? node : { ...node, children: [child] };
}
```

[`producesDistinctRows`](../../src/optimizer/unique-keys.ts) says yes for an `Aggregate` or a `Distinct` unconditionally — both group their input — and for a `Project` whose own output columns form a unique key of the subtree beneath it. Filters, sorts, and limits pass the question through.

Selecting a primary key distinctly:

```
SELECT DISTINCT C_CUSTKEY FROM CUSTOMER

before: -> Distinct                             after: -> Project (CUSTOMER.C_CUSTKEY)
          -> Project (CUSTOMER.C_CUSTKEY)                -> Seq Scan on CUSTOMER as CUSTOMER
            -> Seq Scan on CUSTOMER as CUSTOMER
```

Selecting a non-key column distinctly keeps its `Distinct`, because two customers can share a market segment:

```
SELECT DISTINCT C_MKTSEGMENT FROM CUSTOMER

-> Distinct
  -> Project (CUSTOMER.C_MKTSEGMENT)
    -> Seq Scan on CUSTOMER as CUSTOMER
```

And a `DISTINCT` over something already grouped is free to go, with no primary key involved at all:

```
SELECT DISTINCT C_MKTSEGMENT FROM (SELECT C_MKTSEGMENT FROM CUSTOMER GROUP BY C_MKTSEGMENT) t

-> Project (T.C_MKTSEGMENT)
  -> Project (CUSTOMER.C_MKTSEGMENT)
    -> Aggregate (group by: CUSTOMER.C_MKTSEGMENT)
      -> Seq Scan on CUSTOMER as CUSTOMER
```

Deleting a `Distinct` removes a whole hash table from the plan. This is the cheapest large win in the pipeline when it fires.

## Aggregate pushdown: eliminating rows, not operators

The third pass in this chapter deletes no nodes. It adds two, and removes work anyway.

Consider grouping over a join where the grouping keys and the aggregate inputs all come from one side:

```sql
SELECT o.O_CUSTKEY, SUM(o.O_TOTALPRICE)
FROM ORDERS o JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
GROUP BY o.O_CUSTKEY
```

With 120,000 orders and 2,000 customers, [`AggregatePushdown`](../../src/optimizer/passes/aggregate-pushdown.ts) rewrites it:

```
BEFORE                                          AFTER
-> Project (O.O_CUSTKEY, SUM(O.O_TOTALPRICE))   -> Project (O.O_CUSTKEY, SUM(O.O_TOTALPRICE))
  -> Aggregate (group by: O.O_CUSTKEY)            -> FinalAggregate
       (aggs: SUM(O.O_TOTALPRICE))                  -> Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
    -> Join (condition:                               -> PartialAggregate
         (O.O_CUSTKEY = C.C_CUSTKEY))                   -> Seq Scan on ORDERS as O
      -> Seq Scan on ORDERS as O                      -> Seq Scan on CUSTOMER as C
      -> Seq Scan on CUSTOMER as C
```

The aggregation is now split. A `PartialAggregate` below the join reduces 120,000 orders to 2,000 partial sums; the join probes 2,000 rows instead of 120,000; a `FinalAggregate` above combines. This is sometimes called eager aggregation, and it is the same partial/final split the distributed executor uses.

Four preconditions have to hold, and the pass returns early on each:

**Every aggregate must decompose.** [`decompositionOf`](../../src/planner/aggregate-decomposition.ts) maps each function to a `(partial, final)` pair — `SUM` splits into `SUM`/`SUM`, `COUNT` into `COUNT`/`SUM`, `MIN` into `MIN`/`MIN`. `AVG` splits too, into `AVG_PARTIAL`/`AVG_FINAL`, but it is excluded here: `SINGLE_COLUMN_PARTIAL_FUNCTIONS` removes it because its partial state is two columns, and this pass rewrites in place with one. `DISTINCT` aggregates are rejected outright.

**The grouping keys must all come from one side.** [`soleSideOf`](../../src/optimizer/passes/aggregate-pushdown.ts) returns `null` if any key is not a plain column reference or if the keys straddle both inputs.

**The aggregate arguments must not touch the other side.** Checked by [`aggregateInputsConfinedTo`](../../src/optimizer/passes/aggregate-pushdown.ts).

**The side must be big enough to be worth it.** `Config.eagerAggregationMinRows` is 50,000, and the estimated cardinality of the push side is compared against it.

The partial grouping is not the same as the final grouping. [`partialGroupingFor`](../../src/optimizer/passes/aggregate-pushdown.ts) adds every join-key column from the push side to the grouping list:

```typescript
for (const ref of collectColumnRefs(condition)) {
  if (!pushRefs.has((ref.tableAlias || '').toUpperCase())) continue;
  ...
  grouping.push(ref);
}
```

That is the correctness step. Rows collapsed below the join must still be distinguishable *by the join key*, or the join could not match them. Group only by `O_CUSTKEY` when the join is on `O_ORDERKEY` and you have destroyed the information the join needs.

Finally — and this makes `AggregatePushdown` the first pass in the book that consults the cost model — the rewrite is only kept if it is estimated to be cheaper:

```typescript
return this.isCheaper(candidate, rewritten) ? candidate : rewritten;
```

[`costOf`](../../src/optimizer/passes/aggregate-pushdown.ts) runs the whole [`PhysicalPlanner`](../../src/execution/physical-planner.ts) on each candidate and sums the result with [`totalPhysicalCost`](../../src/execution/physical-plan.ts), returning `null` if planning throws. A `null` for the candidate means keep the original. Chapters 22 through 24 build the machinery those numbers come from.

## In the code

| Idea | Where |
|---|---|
| Join deletion | [`JoinElimination`](../../src/optimizer/passes/join-elimination.ts) |
| The two-part safety test | [`tryEliminateLeftJoin`](../../src/optimizer/passes/join-elimination.ts), [`preservesLeftCardinality`](../../src/optimizer/passes/join-elimination.ts) |
| Uniqueness reasoning | [`isUniqueOnKeys`](../../src/optimizer/unique-keys.ts) |
| Distinct-output reasoning | [`producesDistinctRows`](../../src/optimizer/unique-keys.ts) |
| Distinct deletion | [`DistinctElimination`](../../src/optimizer/passes/distinct-elimination.ts) |
| Where primary keys come from | [`registerTable`](../../src/catalog/catalog.ts) |
| Eager aggregation | [`AggregatePushdown`](../../src/optimizer/passes/aggregate-pushdown.ts) |
| Partial/final splits | [`decompositionOf`](../../src/planner/aggregate-decomposition.ts) |
| Cost check | [`totalPhysicalCost`](../../src/execution/physical-plan.ts) |

## Traps

**Two of these three passes are dormant on a SQL-created table.** No `PRIMARY KEY` in the grammar means no `primaryKey` in the catalog means `isUniqueOnKeys` never returns `true` at a scan. Register the table programmatically to see them work.

**`JoinElimination` only handles `LEFT` joins.** An `INNER` join to a lookup table cannot be deleted the same way even when the right side is unique and unused, because an inner join also *filters*: a left row with no match disappears. Removing it would resurrect rows.

**Uniqueness does not survive an expression.** `SELECT DISTINCT C_CUSTKEY + 0 FROM CUSTOMER` keeps its `Distinct`. Combined with chapter 16's finding that the simplifier does not visit sort or group keys, it is easy to build a query where a redundant `+ 0` costs you a whole hash table.

**[`hasAnyNameUsed`](../../src/optimizer/passes/join-elimination.ts) matches on unqualified column names.** When checking whether the right side is still referenced, the pass compares both aliases and bare output names, so a left-side column that shares a *name* with a right-side column reads as a use of the right side. A self-join demonstrates it:

```
SELECT a.C_NAME FROM CUSTOMER a LEFT JOIN CUSTOMER b ON a.C_NATIONKEY = b.C_CUSTKEY

-> Project (A.C_NAME)
  -> LEFT Join (condition: (A.C_NATIONKEY = B.C_CUSTKEY))
    -> Seq Scan on CUSTOMER as A
    -> Seq Scan on CUSTOMER as B
```

`B` is unique on `C_CUSTKEY` and nothing above reads it, so the join is eliminable — but `C_NAME` is one of `B`'s output names too, so the check says otherwise. Conservative, and invisible in the plan.

**`AggregatePushdown` costs both candidates with the full physical planner.** That is not free, and it runs on every grouped aggregate over an inner join whose push side clears 50,000 estimated rows.

## Recap

- A `LEFT JOIN` can be **deleted** when nothing above it reads the right side and the right side yields at most one row per join key. Both halves are necessary: the first preserves the columns, the second preserves the row count.
- [`isUniqueOnKeys`](../../src/optimizer/unique-keys.ts) proves the second half by recursion — primary keys at scans, grouping keys at aggregates, pass-through for filters and sorts, and **`null` for anything it cannot translate**.
- The same module powers [`DistinctElimination`](../../src/optimizer/passes/distinct-elimination.ts), which deletes a `DISTINCT` whose input is already distinct — over a primary key, over an aggregate, or over another `DISTINCT`.
- Both depend on `primaryKey` in the catalog, and the **SQL grammar cannot set it**. They are live only for tables registered through the programmatic API.
- [`AggregatePushdown`](../../src/optimizer/passes/aggregate-pushdown.ts) splits a grouped aggregate into a **partial** below a join and a **final** above it, adding the join-key columns to the partial grouping so the join can still match. It is gated on decomposability, one-sidedness, a 50,000-row threshold, and an actual cost comparison.

Next: [chapter 21](21-access-paths-and-orderings.md) moves from what the plan computes to how it reaches the data — index scans, zone-map hints, and sorts that turn out to be unnecessary.
