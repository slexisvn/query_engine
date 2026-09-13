# 12. Building the plan

> After this chapter you will be able to trace how SELECT clauses become plan nodes and distinguish initial translation from later optimization.

## The question

Here is a query using every clause SQL offers:

```sql
SELECT c.C_MKTSEGMENT, SUM(o.O_TOTALPRICE) AS TOTAL
FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE o.O_TOTALPRICE > 100
GROUP BY c.C_MKTSEGMENT
HAVING SUM(o.O_TOTALPRICE) > 200
ORDER BY TOTAL DESC
LIMIT 5
```

And here is the plan, straight out of [`createLogicalPlan`](../../src/planner/logical-planner.ts) with no optimization:

```
-> Limit (count: 5)
  -> Project (C.C_MKTSEGMENT, SUM(O.O_TOTALPRICE))
    -> Sort (SUM(O.O_TOTALPRICE) DESC)
      -> Filter (condition: (SUM(O.O_TOTALPRICE) > 200))
        -> Aggregate (group by: C.C_MKTSEGMENT) (aggs: SUM(O.O_TOTALPRICE))
          -> Filter (condition: (O.O_TOTALPRICE > 100))
            -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
              -> Seq Scan on CUSTOMER as C
              -> Seq Scan on ORDERS as O
```

Seven clauses, seven nodes above the two scans, in exactly that order. The `WHERE` filter sits above the join, where it will discard rows *after* the join has already paired them up — which is, as chapter 1 pointed out, the single worst decision in the plan.

The planner knows how to do better. It does not. This chapter is about the rule that produces this shape, and about why "be correct, and let someone else be fast" is the right division of labor rather than a shortcut.

## One clause, one node, in evaluation order

The shape of the tree is not derived from the *text* order of a SQL statement. It comes from the **evaluation order**: the order in which SQL's clauses logically take effect, which is famously not the order in which you write them.

| Step | Clause | Node |
|---|---|---|
| 1 | `FROM` | `Scan`, `Join`, `CTEScan`, or `SingleRow` |
| 2 | `WHERE` | `Filter` |
| 3 | `GROUP BY` | `Aggregate` |
| 4 | `HAVING` | `Filter` |
| 5 | window functions | `Window` |
| 6 | `SELECT` | `Project` (and `Distinct`) |
| 7 | `ORDER BY` | `Sort` |
| 8 | `LIMIT` | `Limit` |

[`planSelect`](../../src/planner/logical-planner.ts) walks that table top to bottom, and each step wraps whatever it has so far:

```typescript
planSelect(bound: BoundSelect): LP.LogicalPlanNode {
  let node: LP.LogicalPlanNode | null = null;

  if (bound.plan) {
    node = this.planFrom(bound.plan);
  } else {
    node = LP.LogicalSingleRow();
  }

  if (bound.where) {
    // ...
    node = LP.LogicalFilter(expr, node);
  }

  if (bound.aggregates.length > 0 || bound.groupBy) {
    node = LP.LogicalAggregate(bound.groupBy || [], bound.aggregates, node);
  }

  if (bound.having) {
    // ...
    node = LP.LogicalFilter(expr, node);
  }
  // ...
```

One mutable local, reassigned once per clause, each time to a node holding the previous value as its child. Everything else about the tree's shape follows.

Two consequences worth stating explicitly.

**The tree is built inside out and therefore reads bottom-up.** The first clause processed ends up deepest; the last ends up at the root. That is where the "plans are upside down relative to SQL" observation from chapter 10 actually comes from — it is not a convention, it is a `let node = ...` reassigned eight times.

**Absent clauses leave no trace.** Every step is guarded, so `SELECT C_NAME FROM CUSTOMER` produces two nodes, not eight. There is no `Filter (condition: TRUE)` for a missing `WHERE`, no `Limit (count: Infinity)`. The passes in Part 3 can therefore assume that any node they see is doing something.

Notice what step 3 keys on: `bound.aggregates.length > 0 || bound.groupBy`. An `Aggregate` node appears if you wrote `GROUP BY` *or* if the binder found an aggregate anywhere in the query. `SELECT COUNT(*) FROM CUSTOMER` has no `GROUP BY` and still gets one, with an empty `groupBy` array meaning "one group, containing everything":

```
-> Project (COUNT_STAR())
  -> Aggregate (aggs: COUNT_STAR())
    -> Seq Scan on CUSTOMER as CUSTOMER
```

## `FROM` builds the bottom

[`planFrom`](../../src/planner/logical-planner.ts) is a four-way dispatch on what the binder resolved the `FROM` clause into:

| Bound form | Produces |
|---|---|
| `TableRef` | `LogicalScan(tableName, columns, alias)` |
| `JoinRef` | `LogicalJoin` over recursive calls on both sides |
| `SubqueryRef` | the subquery's plan, wrapped by `aliasRelation` |
| `CTERef` | the body planned once into `cteMap`, plus a `LogicalCTEScan` here |

`JoinRef` recurses, which means **the join tree mirrors the parse tree exactly**. Write three tables separated by `JOIN` and you get a left-deep tree; add parentheses and you get whatever you parenthesized. Chapter 10 opened with both shapes for the same query, and the planner produced them faithfully because it is not in the business of second-guessing you. Chapter 25 is.

`SubqueryRef` is where [`aliasRelation`](../../src/planner/logical-planner.ts) earns its place. A derived table has a name, and the columns underneath have to answer to it:

```typescript
aliasRelation(plan: LP.LogicalPlanNode, alias: string, columns: OutputColumn[]): LP.LogicalPlanNode {
  if (plan.type === LP.PlanNodeType.PROJECT) return { ...plan, outputAlias: alias };
  const projections = columns.map((col, i) => ({
    ...BoundColumnRef(alias, col.name, i, col.dataType),
    outputName: col.name,
  }));
  return LP.LogicalProject(projections, plan, alias);
}
```

If the subquery already ends in a `Project`, the alias is stamped onto it; otherwise a new `Project` is created purely to carry the name. That is why a derived table shows two stacked projections in some plans and one in others:

```
-> Project (S.C_NAME)
  -> Filter (condition: (S.C_MKTSEGMENT = 'BUILDING'))
    -> Project (CUSTOMER.C_NAME, CUSTOMER.C_MKTSEGMENT)
      -> Seq Scan on CUSTOMER as CUSTOMER
```

## The `DISTINCT` fork

Steps 6 and 7 are the only place the planner branches on something other than presence, and the branch changes the *order* of three nodes:

```typescript
if (bound.distinct) {
  const projections = bound.selectItems.map(projectionExpr);
  node = LP.LogicalProject(projections, node);
  node = LP.LogicalDistinct(node);
  if (bound.orderBy) {
    node = LP.LogicalSort(orderKeysOverProjection(bound.orderBy, projections), node);
  }
} else {
  if (bound.orderBy) {
    node = LP.LogicalSort(bound.orderBy, node);
  }
  const projections = bound.selectItems.map(projectionExpr);
  node = LP.LogicalProject(projections, node);
}
```

Without `DISTINCT`, `Sort` goes **below** `Project`:

```
-> Project (CUSTOMER.C_NAME)
  -> Sort (CUSTOMER.C_MKTSEGMENT ASC)
    -> Seq Scan on CUSTOMER as CUSTOMER
```

That is `SELECT C_NAME FROM CUSTOMER ORDER BY C_MKTSEGMENT`, and it works precisely because the sort happens while `C_MKTSEGMENT` still exists. Ordering by a column you did not select is legal SQL, and this node order is why.

With `DISTINCT`, sorting first would be wrong — deduplication can remove rows in any order it likes, so the sort has to happen last:

```
-> Sort (C_MKTSEGMENT ASC)
  -> Distinct
    -> Project (CUSTOMER.C_MKTSEGMENT)
      -> Seq Scan on CUSTOMER as CUSTOMER
```

But now the sort key has to be found in the projected output, because the original columns are gone. [`orderKeysOverProjection`](../../src/planner/logical-planner.ts) rewrites each key into a positional reference to a projected column, matching by [`exprKey`](../../src/binder/expr-key.ts) — the structural identity function from chapter 9. Look at the printed key above: `C_MKTSEGMENT` with no `CUSTOMER.` prefix, because it is now a reference to output column 0, not to a table column.

When the match fails, there is nothing to point at, and the planner refuses:

```
ORDER BY expression must appear in the SELECT DISTINCT list: CUSTOMER.C_MKTSEGMENT
```

This is one of very few errors the planner raises at all — nearly everything else is caught earlier, by the binder. The name that appears in the message comes from [`projectedColumnName`](../../src/planner/project-schema.ts), a four-line function that decides what a projected expression is called:

```typescript
export function projectedColumnName(expr: ProjectedExpr, index: number): string {
  const named = expr as NamedExpr;
  return named?.outputName || named?.alias || named?.name || named?.columnName || `col${index}`;
}
```

An explicit `AS` alias wins, then a function name, then a bare column name, and finally `col0`, `col1` — a positional fallback so that no expression is ever nameless. Its companion [`projectedColumnAlias`](../../src/planner/project-schema.ts) decides whether an output column keeps its table qualifier, which it does only for a plain column reference whose name did not change.

## Subqueries become joins here

The planner does one genuinely non-mechanical thing: it takes subqueries out of expressions and turns them into plan nodes. [`extractSubqueries`](../../src/planner/logical-planner.ts) walks a bound expression with [`walkAndReplace`](../../src/planner/logical-planner.ts), and every subquery it meets is replaced in the expression by a column reference while a closure that will wrap the plan is pushed onto a list. Those closures are then applied in order.

For `EXISTS` in a `WHERE` clause, the replacement is nothing at all — the subquery *is* the whole conjunct, so it vanishes from the expression and becomes a join:

```
-> Project (C.C_NAME)
  -> Dependent Join (EXISTS)
    -> Seq Scan on CUSTOMER as C
    -> Project (1)
      -> Filter (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
        -> Seq Scan on ORDERS as O
```

For a scalar subquery in a select list, the replacement is a reference to a generated column name, and a `COALESCE` is wrapped around it when the subquery is a bare `COUNT` that must produce `0` rather than `NULL` on empty input:

```
-> Project (C.C_NAME, COALESCE(_scalar_0, 0))
  -> Dependent Join (SCALAR)
    -> Seq Scan on CUSTOMER as C
    -> Project (COUNT_STAR())
      -> Aggregate (aggs: COUNT_STAR())
        -> Filter (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
          -> Seq Scan on ORDERS as O
```

[`findCorrelatedRefs`](../../src/planner/logical-planner.ts) collects the outer columns the subquery mentions, and enforces the engine's one hard limit here — a subquery may reach exactly one level out:

```
Correlated reference to C.C_CUSTKEY spans 2 query levels; only one level of correlation is supported
```

Two levels is rejected rather than silently mis-planned. Chapters 26 and 27 explain what decorrelation would have to do to lift the restriction.

## Correctness, not speed

The list of things the planner declines to do is short, and every item is somebody else's chapter.

- **It does not reorder joins.** The tree matches your `FROM` clause. (Chapter 25.)
- **It does not move predicates.** `WHERE` becomes a `Filter` exactly where the evaluation order puts it. (Chapter 17.)
- **It does not consult statistics.** It never asks how many rows a table has, so it cannot prefer one shape over another. (Chapter 22.)
- **It does not choose algorithms.** `Join` says join, not hash join. (Chapter 29.)
- **It does not eliminate anything.** A redundant `Distinct` or an always-false filter is transcribed faithfully. (Chapter 20.)

Run the opening query through the optimizer and every one of those omissions is repaired:

```
-> Project (C.C_MKTSEGMENT, SUM(O.O_TOTALPRICE))
  -> Top-N (count: 5, order: SUM(O.O_TOTALPRICE) DESC)
    -> Filter (condition: (SUM(O.O_TOTALPRICE) > 200))
      -> Aggregate (group by: C.C_MKTSEGMENT) (aggs: SUM(O.O_TOTALPRICE))
        -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
          -> Filter (condition: (O.O_TOTALPRICE > 100))
            -> Seq Scan on ORDERS as O
          -> Seq Scan on CUSTOMER as C
```

The `WHERE` filter has moved onto the `ORDERS` scan, the join's inputs have swapped, and `Sort` plus `Limit` have fused into `Top-N`. The `HAVING` filter stayed put, correctly, because it mentions an aggregate.

The reason to split the work this way is that **the planner has a focused correctness obligation**: does the tree mean what the SQL means? A planner that also reordered joins would tangle two obligations together, and a wrong answer would leave you unsure which half caused it. Chapter 53's first diagnostic question is always "is the unoptimized plan right?" — worth being able to answer.

## How everything after this walks the tree

The planner emits a tree, and everything downstream rewrites it. Every rewriter in the engine shares one base class, [`PlanRewriter`](../../src/planner/plan-rewriter.ts), and its whole implementation is three methods:

```typescript
rewrite(node: LogicalPlanNode, context?: C): LogicalPlanNode {
  const method = descriptorOf(node.type).rewriteMethod;
  const handler = (method ? this[method] : undefined) as NodeRewriteFn<C> | undefined;
  return handler ? handler.call(this, node, context) : this.rewriteDefault(node, context);
}

rewriteDefault(node: LogicalPlanNode, context?: C): LogicalPlanNode {
  return this.rewriteChildren(node, context);
}
```

The twenty-three `rewriteScan?`, `rewriteFilter?`, … declarations on the class are **optional and unimplemented**. The base class defines none of them, so `this[method]` is `undefined` unless a subclass supplied one, and everything else falls through to `rewriteDefault`. A pass that cares about joins overrides `rewriteJoin` and inherits correct traversal of the other twenty-two node types for free.

The dispatch is not a `switch`. `descriptorOf` looks the node type up in [`plan-node-descriptor.ts`](../../src/planner/plan-node-descriptor.ts), one record that also holds each node's physical operator, cost rule, and distributed-execution capability — so adding a node type there teaches the rewriter, the coster, and the physical planner about it at once.

The third method is where the immutability of chapter 11 pays off:

```typescript
rewriteChildren<T extends LogicalPlanNode>(node: T, context?: C): T {
  const children = getChildren(node);
  if (children.length === 0) return node;

  const newChildren = children.map(child => this.rewrite(child, context));
  const changed = newChildren.some((child, i) => child !== children[i]);
  return changed ? setChildren(node, newChildren) : node;
}
```

If nothing below a node changed, the node itself is returned **by identity**. Run an empty rewriter over a plan and you get the same object back, `===` and all. Passes rely on that: ten places across seven passes are written as `if (child !== node.children[0]) { ... }`, rebuilding a node only when its subtree actually moved. The optimizer's own fixpoint loop does not use identity — [`runToFixpoint`](../../src/optimizer/optimizer.ts) compares [`planSignature`](../../src/optimizer/plan-signature.ts) strings, because a pass may return a fresh but equivalent tree — but every pass below it allocates far less because of this line.

Most of the subclasses are the optimizer passes in `src/optimizer/passes/`, one or two per file; the rest are the distributed rewrites under `src/distributed/` and one outlier. That outlier is [`PlanPropertiesRewriter`](../../src/planner/plan-properties.ts), which the exported [`PlanPropertyAnnotator`](../../src/planner/plan-properties.ts) wraps; it overrides only `rewriteDefault`, and so annotates every node type uniformly with a cardinality estimate and an inferred sort order.

## In the code

| Thing | Where |
|---|---|
| Entry point | [`createLogicalPlan`](../../src/planner/logical-planner.ts) |
| Clause order | [`planSelect`](../../src/planner/logical-planner.ts) |
| `FROM` handling | [`planFrom`](../../src/planner/logical-planner.ts) |
| Derived-table naming | [`aliasRelation`](../../src/planner/logical-planner.ts) |
| `DISTINCT` sort keys | [`orderKeysOverProjection`](../../src/planner/logical-planner.ts) |
| Subquery hoisting | [`extractSubqueries`](../../src/planner/logical-planner.ts) |
| Correlation depth check | [`findCorrelatedRefs`](../../src/planner/logical-planner.ts) |
| Output column naming | [`projectedColumnName`](../../src/planner/project-schema.ts) |
| Tree rewriting | [`PlanRewriter`](../../src/planner/plan-rewriter.ts) |
| Per-node dispatch data | [`descriptorOf`](../../src/planner/plan-node-descriptor.ts) |

## Traps

**`LIMIT` must be a literal, and is not checked.** [`applyLimit`](../../src/planner/logical-planner.ts) casts the bound expression to a literal and reads `.value`. For `LIMIT 1 + 1` that is `undefined`, the plan prints `Limit (count: undefined)`, and the query returns zero rows with no error. `LIMIT $1` is fine, because chapter 9's binder has already turned the parameter into a literal.

**The planner mutates the bound query it was given.** The subquery-extraction loop writes back with `bound.selectItems[i] = { ...bound.selectItems[i], expr }` — the select item now holds the *replacement* column reference, and the subquery it came from is gone. Plan the same `BoundQuery` twice and the second plan is not the first:

```
-> Project (C.C_NAME, COALESCE(_scalar_0, 0))
  -> Dependent Join (SCALAR)
    -> Seq Scan on CUSTOMER as C
    -> Project (COUNT_STAR())
      -> Aggregate (aggs: COUNT_STAR())
        -> Filter (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
          -> Seq Scan on ORDERS as O

-> Project (C.C_NAME, COALESCE(_scalar_0, 0))
  -> Seq Scan on CUSTOMER as C
```

The second plan still references `_scalar_0` and no longer computes it. Bind again for each plan.

**Generated names come from module-level counters.** `_cteIdCounter` in the planner and `_scalarOutputCounter` behind [`nextScalarOutputName`](../../src/planner/logical-plan.ts) are module state, not per-query state, and they only ever go up. Two plans in one process can never collide on `_scalar_0` — but neither can the same query planned twice, which gets `_scalar_0` and then `_scalar_1`. A plan's printed form is therefore not stable across runs, so a test or a diff that pins one is pinning the counter as much as the plan.

**`createLogicalPlan` mutates the root it returns**, assigning `plan._cteMap = planner.cteMap`. Only the root carries it, so a pass that returns a *new* root without copying that field loses every CTE body in the query.

**`rewriteDefault` is a trap in the other direction.** Overriding it to inspect nodes is convenient, but a subclass that also overrides `rewriteJoin` will not see joins there — the specific handler wins and `rewriteDefault` is never reached for that type.

## Recap

- The plan's shape is the SQL **evaluation order** — `FROM`, `WHERE`, `GROUP BY`, `HAVING`, windows, `SELECT`, `ORDER BY`, `LIMIT` — realized as one local variable reassigned once per clause, each time wrapping the previous value.
- Because the wrapping is inside-out, the first clause evaluated ends up **deepest**, which is why plans read bottom-up. Absent clauses produce no node at all.
- `FROM` builds the bottom, and the **join tree mirrors the parse tree**: parenthesization in your SQL is parenthesization in the plan.
- `DISTINCT` moves `Sort` **above** `Project`, which forces order keys to be rewritten as references into the projected output — and makes ordering by an unselected column an error.
- Subqueries are turned into `DependentJoin` nodes **here**, in the planner, not in the optimizer; only one level of correlation is supported, and deeper nesting is rejected with a message.
- The planner is built for **correctness**: no reordering, no statistics, no algorithm choice, no elimination. The tree it emits is the naive one on purpose, and Part 3 is what fixes it.
- Everything downstream walks that tree through [`PlanRewriter`](../../src/planner/plan-rewriter.ts), whose unimplemented per-node hooks fall back to `rewriteDefault`, and whose `rewriteChildren` returns nodes **by identity** when nothing changed — which is what lets a pass rebuild only the subtrees it touched.

Next: chapter 13 reads the output — [the two plan printers](13-reading-explain.md), why there are two, and what neither one tells you.
