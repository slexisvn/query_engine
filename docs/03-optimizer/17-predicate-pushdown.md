# 17. Predicate pushdown

> After this chapter you will be able to predict where any `WHERE` clause ends up in the plan, and explain the single most notorious gotcha in SQL as a consequence of one line in this pass.

## The question

These two queries look like the same query written two ways:

```sql
SELECT c.C_NAME, o.O_TOTALPRICE
FROM CUSTOMER c LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE o.O_TOTALPRICE > 50
```

```sql
SELECT c.C_NAME, o.O_TOTALPRICE
FROM CUSTOMER c LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY AND o.O_TOTALPRICE > 50
```

They are not. The first silently stops being an outer join. The second stays one. Every SQL developer trips over this at least once, and it is usually explained as a rule to memorize. It is not a rule — it is a consequence, and by the end of this chapter you will be able to derive it from the nine lines of code that cause it.

## The idea

A filter is a function that throws rows away. Every operator sitting above it therefore processes fewer rows. So the optimization writes itself: **move filters down the tree as far as they can legally go.**

"As far as they can legally go" is where all the difficulty lives, and it is the only part of this pass that is interesting.

Here is the pass doing its job on the book's running query:

```
BEFORE                                          AFTER
-> Limit (count: 10)                            -> Limit (count: 10)
  -> Project (...)                                -> Project (...)
    -> Sort (...)                                   -> Sort (...)
      -> Aggregate (group by: C.C_NAME)               -> Aggregate (group by: C.C_NAME)
        -> Filter (C.C_MKTSEGMENT = 'BUILDING')         -> Join (C.C_CUSTKEY = O.O_CUSTKEY)
          -> Join (C.C_CUSTKEY = O.O_CUSTKEY)             -> Filter (C.C_MKTSEGMENT = 'BUILDING')
            -> Seq Scan on CUSTOMER as C                    -> Seq Scan on CUSTOMER as C
            -> Seq Scan on ORDERS as O                    -> Seq Scan on ORDERS as O
```

The filter travelled from above the join to inside its left input. At TPC-H scale that removes roughly four fifths of the rows before the join ever sees them, and the join is the most expensive operator in the plan.

## Splitting first

`WHERE a AND b AND c` is one expression, but it is really three independent filters, and they may not all be able to move to the same place. So the pass never reasons about a whole `WHERE` clause. It reasons about [conjuncts](../01-frontend/09-types-and-expressions.md):

```typescript
override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
  const child = this.rewrite(node.children[0]);
  const predicates = splitConjuncts(node.condition);
  return pushPredicates(predicates, child);
}
```

[`splitConjuncts`](../../src/binder/conjuncts.ts) flattens the `AND` tree into an array; [`combineConjuncts`](../../src/binder/conjuncts.ts) puts back whatever could not move. This split-and-recombine shape is what lets one conjunct of a `WHERE` clause land on the left scan while another stays above the join.

Note also that the filter node itself **disappears**. `pushPredicates` does not return a `Filter` wrapping something; it returns whatever the predicates ended up embedded in. A new `Filter` is created only at the bottom, at the point where the predicate can go no further:

```typescript
if (predicates.length === 0) return target;
return LogicalFilter(combineConjuncts(predicates), target);
```

## How far down can a predicate go?

[`pushPredicates`](../../src/optimizer/passes/predicate-pushdown.ts) dispatches on the node it is trying to push *into*. There are four interesting cases.

### Into another filter

Merge and keep going. Two stacked filters are one filter with more conjuncts, so the pass concatenates the predicate lists and recurses into the child. This is why you rarely see two adjacent `Filter` nodes in a plan.

### Through a projection

A predicate can move below a `Project` only if the columns it mentions still exist below it. [`canPushThroughProject`](../../src/optimizer/passes/predicate-pushdown.ts) collects the predicate's column references and checks each one against the columns the child produces. A filter on a computed alias — `WHERE total > 100` where `total` is `SUM(...)` defined in the projection — fails this check and stays put, because below the projection there is no column called `total`.

### Through an aggregate

This is the first case where correctness is genuinely at stake. Filtering before grouping and filtering after grouping are different operations — unless the predicate only touches **grouping keys**, in which case every row of a group agrees on it, and so whole groups are kept or discarded either way.

The pass builds the set of group-by columns and admits a predicate only if it references nothing else and contains no aggregate:

```typescript
if (refs.length > 0 && !containsAggregate(pred) && refs.every((r) => groupByRefs.has(...))) {
  pushable.push(pred);
} else {
  remaining.push(pred);
}
```

Real output, for `GROUP BY c.C_NAME HAVING c.C_NAME = 'Alice'`:

```
BEFORE                                     AFTER
-> Filter (C.C_NAME = 'Alice')             -> Aggregate (group by: C.C_NAME)
  -> Aggregate (group by: C.C_NAME)          -> Filter (C.C_NAME = 'Alice')
    -> Seq Scan on CUSTOMER as C               -> Seq Scan on CUSTOMER as C
```

The hash table now builds one group instead of all of them. Change the predicate to `HAVING COUNT(*) > 5` and it does not move at all: `containsAggregate` rejects it, and it must not move, because `COUNT(*)` does not exist until after grouping.

### Into a join

The most valuable case, and the one with the rules people memorize. [`pushIntoJoin`](../../src/optimizer/passes/predicate-pushdown.ts) sorts each predicate into one of four buckets by asking which side's columns it touches — using [`collectPlanRefs`](../../src/optimizer/passes/plan-refs.ts) to find out what each subtree actually produces:

| Bucket | Meaning |
|---|---|
| `leftPreds` | mentions only left-side columns — push into the left input |
| `rightPreds` | mentions only right-side columns — push into the right input |
| `joinPreds` | mentions both sides — fold into the join condition |
| `remaining` | cannot move — stays as a filter above the join |

What lands where depends on the join type.

**INNER and CROSS.** Everything moves. Left-only goes left, right-only goes right, and anything spanning both becomes part of the join condition. That last case is worth seeing, because it does not look like pushdown at all:

```
BEFORE                                          AFTER
-> Filter ((C.C_CUSTKEY + O.O_ORDERKEY) > 5)    -> Join ((C.C_CUSTKEY = O.O_CUSTKEY)
  -> Join (C.C_CUSTKEY = O.O_CUSTKEY)                   AND ((C.C_CUSTKEY + O.O_ORDERKEY) > 5))
    -> Seq Scan on CUSTOMER as C                  -> Seq Scan on CUSTOMER as C
    -> Seq Scan on ORDERS as O                    -> Seq Scan on ORDERS as O
```

The predicate is now evaluated *during* the join, on each candidate pair, instead of on a fully materialized result. And notice the accompanying rule: a `CROSS` join that acquires a condition is rewritten as an `INNER` join, because that is now what it is.

**SEMI, ANTI, and MARK** — the join types that subquery unnesting produces, covered in chapter 26 — behave like inner joins for left-only and right-only predicates, but anything spanning both sides stays above the join.

**LEFT is the interesting one.**

## Why LEFT JOIN loses its outerness

A left join promises: every left row appears in the output, padded with `NULL`s if nothing on the right matched. Now consider pushing a right-only predicate below it.

Take one customer with no orders. The left join emits `(Alice, NULL)`. Then `WHERE o.O_TOTALPRICE > 50` evaluates `NULL > 50`, which in SQL is `NULL`, which is not true, so the row is discarded anyway.

That is the whole argument. The predicate was going to delete every `NULL`-padded row regardless, so the outer join was never doing anything, so it may as well be an inner join — and once it is an inner join, the predicate is free to move into the right input. This is exactly what the code does:

```typescript
} else if (joinNode.joinType === JoinType.LEFT) {
  if (leftOnly) leftPreds.push(pred);
  else if (rightOnly && isNullRejecting(pred, rightRefs)) {
    rightPreds.push(pred);
    joinNode = { ...joinNode, joinType: JoinType.INNER };
  } else {
    remaining.push(pred);
  }
}
```

[`isNullRejecting`](../../src/optimizer/passes/null-rejection.ts) is the guard: it asks whether the predicate is guaranteed to be false or unknown when its columns are `NULL`. `o.O_TOTALPRICE > 50` is null-rejecting. `o.O_TOTALPRICE IS NULL` is not — it is *satisfied* by the padded rows, so it must not move, and the join must stay `LEFT`. That single check is the difference between an optimization and a wrong answer.

Here is the demotion in real output:

```
BEFORE                                          AFTER
-> Filter (O.O_TOTALPRICE > 50)                 -> Join (C.C_CUSTKEY = O.O_CUSTKEY)
  -> LEFT Join (C.C_CUSTKEY = O.O_CUSTKEY)        -> Seq Scan on CUSTOMER as C
    -> Seq Scan on CUSTOMER as C                  -> Filter (O.O_TOTALPRICE > 50)
    -> Seq Scan on ORDERS as O                      -> Seq Scan on ORDERS as O
```

`LEFT Join` became `Join`. The engine did not misunderstand your query — it observed that your query had already stopped being an outer join before it got here.

## The ON clause is a different door

Now the second query from the opening. Putting the condition in `ON` rather than `WHERE` means it never becomes a `Filter` node at all; it arrives as part of the join condition. A different method handles it — [`pushJoinConditionPredicates`](../../src/optimizer/passes/predicate-pushdown.ts), reached from `rewriteJoin`:

```typescript
if (joinNode.joinType === JoinType.LEFT) {
  if (rightOnly) rightPreds.push(pred);
  else joinPreds.push(pred);
} else {
  joinPreds.push(pred);
}
```

Right-only conjuncts of a `LEFT` join's `ON` clause move into the right input — **and the join type is not touched.** Real output:

```
BEFORE                                             AFTER
-> LEFT Join ((C.C_CUSTKEY = O.O_CUSTKEY)          -> LEFT Join (C.C_CUSTKEY = O.O_CUSTKEY)
        AND (O.O_TOTALPRICE > 50))                   -> Seq Scan on CUSTOMER as C
  -> Seq Scan on CUSTOMER as C                       -> Filter (O.O_TOTALPRICE > 50)
  -> Seq Scan on ORDERS as O                           -> Seq Scan on ORDERS as O
```

Same filter placement as the `WHERE` version. Different join type. And that is correct in both cases: `ON` restricts *what counts as a match*, so a customer with only cheap orders still appears, padded with `NULL`s. `WHERE` restricts *the final result*, so that customer is gone.

Put the two plans side by side and the folklore rule — "filter the outer side in `ON`, not in `WHERE`" — stops being folklore. It is a statement about which of these two functions your predicate is routed through.

## Why the pass runs more than once

Ask the optimizer for its pass list and `PredicatePushdown` appears twice:

```
ExpressionSimplifier
SubqueryUnnesting
HavingPushdown
CTEOptimization
PredicatePushdown        <- inside the PredicateOptimization fixpoint
PredicateInference
OuterToInnerJoin
JoinReorder
PredicatePushdown        <- again, after join reordering
JoinElimination
...
```

The first occurrence is not a plain pass. [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) registers it inside a **fixpoint stage**:

```typescript
.registerFixpoint(PREDICATE_FIXPOINT_STAGE, [
  new PredicatePushdown(),
  new PredicateInference(),
  new OuterToInnerJoin(),
])
```

[`registerFixpoint`](../../src/optimizer/optimizer.ts) reruns the group until the plan stops changing, up to `optimizerFixpointIterations` rounds — eight by default. The three passes feed each other: pushdown moves predicates down, inference derives new predicates from the ones that moved (if `a = b` and `a > 5` then `b > 5`), and those new predicates are themselves pushable. One pass through would find only the first layer.

The second occurrence exists because [`JoinReorder`](../../src/optimizer/passes/join-reorder.ts) rebuilds the join tree entirely. A predicate that had nowhere to go under the old shape may have somewhere to go under the new one, so the engine simply asks again. **A pass being cheap and idempotent is what makes running it repeatedly a reasonable design** rather than a smell.

## In the code

| Idea | Where |
|---|---|
| The pass | [`PredicatePushdown`](../../src/optimizer/passes/predicate-pushdown.ts) |
| Tree walk | [`PushdownRewriter`](../../src/optimizer/passes/predicate-pushdown.ts), on [`PlanRewriter`](../../src/planner/plan-rewriter.ts) |
| Placement logic | [`pushPredicates`](../../src/optimizer/passes/predicate-pushdown.ts) |
| Join routing | [`pushIntoJoin`](../../src/optimizer/passes/predicate-pushdown.ts) |
| ON-clause routing | [`pushJoinConditionPredicates`](../../src/optimizer/passes/predicate-pushdown.ts) |
| Outer-join safety | [`isNullRejecting`](../../src/optimizer/passes/null-rejection.ts) |
| Splitting `AND` | [`splitConjuncts`](../../src/binder/conjuncts.ts) |
| Which columns a subtree has | [`collectPlanRefs`](../../src/optimizer/passes/plan-refs.ts) |
| Fixpoint wiring | [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) |

## Traps

**Pushing a predicate down is not always faster.** Evaluating an expensive predicate on a large scan can cost more than evaluating a cheap one on a small join result. This pass does not care — it pushes unconditionally, and [`FilterOrdering`](../../src/optimizer/passes/filter-ordering.ts) later reorders conjuncts within a filter by estimated cost and selectivity, the fraction of rows a predicate keeps ([chapter 21](21-access-paths-and-orderings.md) puts a number on it). Separating "where can it go" from "is it worth it" keeps both passes simple.

**Column references are compared by uppercased alias and name**, built into strings like `C.C_CUSTKEY` in `collectColumnRefs`. Two different subqueries using the same alias would collide, which is precisely why the binder guarantees unique aliases before the optimizer ever runs.

**`remaining` is not a failure.** A predicate left above the join is often correct and unavoidable — a `LEFT JOIN` with `WHERE o.x IS NULL` (the anti-join idiom) must keep its filter exactly where you wrote it, and the plan is right to look "unoptimized".

## Exercises

1. Reproduce the four plans in this chapter. Build the optimizer with only this pass registered so nothing else muddies the output:

   ```javascript
   const optimizer = new Optimizer().registerPass(new PredicatePushdown());
   console.log(formatPlan(optimizer.optimize(engine.plan(engine.bind(engine.parseSQL(sql))), {})));
   ```

2. Replace `WHERE o.O_TOTALPRICE > 50` with `WHERE o.O_TOTALPRICE IS NULL` and confirm the join stays `LEFT`. Which function made that decision?

3. Write a query where one conjunct of the `WHERE` clause reaches a scan and another is stranded above the join. Predict the plan before running it.

4. Delete the `isNullRejecting` check so every right-only predicate pushes and the join always demotes to `INNER`. Run `npm run test:e2e`. Which test catches you, and does its failure message actually explain what broke?

5. Comment out the second `PredicatePushdown` registration in `createDefaultOptimizer` and find a query whose plan gets worse. Hint: it needs a join order that only becomes favorable after `JoinReorder` runs.

## Recap

- Predicate pushdown moves filters down the plan so that operators above them see fewer rows. It is the highest-value rewrite in the pipeline.
- `WHERE` clauses are split into **conjuncts** and placed independently; the original `Filter` node dissolves and is recreated wherever each piece comes to rest.
- Legality depends on the node being pushed through: projections require the columns to still exist, aggregates require the predicate to touch only **grouping keys** and contain no aggregate, joins depend on the join type.
- A **null-rejecting** predicate on the right side of a `LEFT JOIN` demotes it to an `INNER` join. That is the mechanism behind SQL's most famous surprise, and `ON` avoids it because it is routed through a different function that leaves the join type alone.
- The pass runs inside a **fixpoint stage** with predicate inference, and again after join reordering, because it is cheap and idempotent.

Next: [chapter 18](18-inference-and-outer-to-inner.md) covers `PredicateInference`, the pass that manufactures predicates out of transitivity and hands them to this one.
