# 18. Inference, null rejection, and outer-to-inner

> After this chapter you will be able to explain why a filter appears on a table your `WHERE` clause never mentioned, and why a `FULL OUTER JOIN` can turn into a `LEFT JOIN` and stop there.

## The question

Write a query that filters exactly one table:

```sql
SELECT c.C_NAME
FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE c.C_CUSTKEY = 42
```

The optimizer produces a plan that filters two:

```
-> Project (C.C_NAME)
  -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
    -> Filter (condition: (C.C_CUSTKEY = 42))
      -> Seq Scan on CUSTOMER as C
    -> Filter (condition: (O.O_CUSTKEY = 42))
      -> Seq Scan on ORDERS as O
```

`O.O_CUSTKEY = 42` is not in the query. Nobody wrote it. It is correct — the join condition says the two columns are equal for any surviving row, so restricting one restricts the other — and it is very valuable, because it turns a full scan of `ORDERS` into a scan that discards 199 customers' worth of orders before the join.

This chapter is about the two passes that share the predicate fixpoint with pushdown: the one that manufactures predicates like that, and the one that uses predicates to weaken outer joins.

## Inference cannot see the predicate on its own

Run [`PredicateInference`](../../src/optimizer/passes/predicate-inference.ts) alone on that query and nothing happens at all — the plan comes back byte-identical. Run `PredicatePushdown` first and then inference, and you get the plan above.

The reason is in how [`InferenceRewriter`](../../src/optimizer/passes/predicate-inference.ts) gathers the predicates it reasons from. `rewriteJoin` collects three things:

```typescript
const preds = splitConjuncts(newNode.condition);
const allPreds = [...preds];
collectFiltersAbove(newNode.children[0], allPreds);
collectFiltersAbove(newNode.children[1], allPreds);
```

The join's own condition, plus whatever [`collectFiltersAbove`](../../src/optimizer/passes/predicate-inference.ts) finds — and that function looks at exactly one node:

```typescript
function collectFiltersAbove(node: LogicalPlanNode, preds: BoundExpr[]): void {
  if (!node) return;
  if (node.type === PlanNodeType.FILTER) {
    preds.push(...splitConjuncts(node.condition));
  }
}
```

If the join's immediate child is a `Filter`, its conjuncts join the pool. If it is anything else, nothing does. In the unoptimized plan the filter sits *above* the join, so both children are scans and the pool holds only the join condition, from which nothing follows.

So the order inside the fixpoint stage is not incidental. Pushdown moves the filter to where inference can see it; inference derives a new predicate; and because the derived predicate is planted directly on the other child, no second pushdown is needed to place it. The three passes registered together in [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) are a pipeline, not a set.

## What can be inferred

[`inferNewPredicates`](../../src/optimizer/passes/predicate-inference.ts) builds two maps over the pooled predicates: `equalities`, a symmetric column-to-columns relation gathered from every `col = col` predicate, and `constants`, a column-to-literal map gathered from every `col = literal`. Then it derives.

**Constants across equalities.** For each column with a known constant, every column it is equal to gets the same constant. This is the opening example.

**Comparisons across equalities.** The same propagation, but for `<`, `>`, `<=`, `>=`, and `<>`:

```
WHERE c.C_CUSTKEY > 100     ->  Filter (condition: (O.O_CUSTKEY > 100)) on the ORDERS side
```

The propagated predicate keeps the literal on the side it was written, using [`BoundBinary`](../../src/binder/expression-binder.ts) to build `col op literal` or `literal op col` to match the original.

**In-lists out of disjunctions.** [`inferInListsFromOr`](../../src/optimizer/passes/predicate-inference.ts) splits an `OR` into branches, collects each branch's constraints, and keeps only the columns constrained to literals in *every* branch. The union of those literals is a sound `IN` list:

```sql
WHERE (C_CUSTKEY = 1 AND C_NATIONKEY = 3) OR (C_CUSTKEY = 2 AND C_NATIONKEY = 4)
```

```
-> Filter (condition: (((((CUSTOMER.C_CUSTKEY = 1) AND (CUSTOMER.C_NATIONKEY = 3)) OR ((CUSTOMER.C_CUSTKEY = 2) AND (CUSTOMER.C_NATIONKEY = 4))) AND <BoundInList>) AND <BoundInList>))
```

Two `IN` lists were added — `C_CUSTKEY IN (1, 2)` and `C_NATIONKEY IN (3, 4)` — and neither is readable, because [`formatExpression`](../../src/planner/plan-formatter.ts) has no case for `IN_LIST` and falls back to the kind name, as [chapter 13](../02-logical-plan/13-reading-explain.md) described. The original disjunction stays: the inferred lists are *necessary* conditions, not equivalent ones. `C_CUSTKEY = 1 AND C_NATIONKEY = 4` satisfies both `IN` lists and neither original branch, so the `OR` must still be evaluated.

**Ranges out of disjunctions.** [`inferRangePredicatesFromOr`](../../src/optimizer/passes/predicate-inference.ts) does the same thing for bounded ranges, taking the loosest lower bound and the loosest upper bound across branches:

```sql
WHERE (C_CUSTKEY > 10 AND C_CUSTKEY < 20) OR (C_CUSTKEY > 50 AND C_CUSTKEY < 60)
```

```
-> Filter (condition: (((((CUSTOMER.C_CUSTKEY > 10) AND (CUSTOMER.C_CUSTKEY < 20)) OR ((CUSTOMER.C_CUSTKEY > 50) AND (CUSTOMER.C_CUSTKEY < 60))) AND (CUSTOMER.C_CUSTKEY > 10)) AND (CUSTOMER.C_CUSTKEY < 60)))
```

`C_CUSTKEY > 10 AND C_CUSTKEY < 60` is the bounding box of two disjoint ranges. As a filter it is nearly worthless — it only excludes what the `OR` already excludes. As a *conjunct* it is worth a great deal, because it is a simple range on a single column, which is exactly the shape that index selection and zone-map pruning can use, and the `OR` is not.

Both `OR` rules require a bound in every branch. Drop `AND C_CUSTKEY < 60` from the second branch and `entries.every(e => e.lower && e.upper)` fails, and nothing is inferred.

## Guarding against re-derivation

Every derived predicate is keyed with [`predKey`](../../src/optimizer/passes/predicate-inference.ts) and checked against `existingKeys` before being added, so a single run never emits a duplicate.

Across runs it can, and does. [Chapter 15](15-passes-and-fixpoints.md) traced the query where pushdown moves a derived predicate two levels down, out of `collectFiltersAbove`'s one-node field of view, and inference derives it again on the next iteration — one copy per iteration until the fixpoint hits its cap. The duplicate-suppression here is per-invocation only.

## Inference stops at inner joins

`rewriteJoin` returns early unless the join is `INNER` with a condition:

```typescript
if (newNode.joinType !== JoinType.INNER || !newNode.condition) return newNode;
```

The reason is the same one that makes the rest of this chapter necessary. In a `LEFT JOIN`, the condition `c.C_CUSTKEY = o.O_CUSTKEY` does *not* hold for every output row — the padded rows have `NULL` on the right and satisfy nothing. Propagating a constant from left to right across that equality would filter away right-side rows that the outer join was supposed to keep.

## Null rejection, stated once

The other half of the chapter needs one function. [`isNullRejecting`](../../src/optimizer/passes/null-rejection.ts) answers: *if these columns were all `NULL`, would this predicate fail to be true?*

```typescript
export function isNullRejecting(expr: BoundExpr, nullSupplyingRefs: NullColumnSource): boolean {
  const result = evaluateWithNulls(expr, suppliesNull(nullSupplyingRefs));
  return result === false || result === null;
}
```

[`evaluateWithNulls`](../../src/optimizer/passes/null-rejection.ts) is an abstract interpreter over four values: `true`, `false`, `null`, and `'UNKNOWN'`. The first three are SQL's three-valued logic. The fourth means *this engine cannot tell* — it is what a column reference from a non-null-supplying relation evaluates to, and what any function call, cast, or `CASE` evaluates to.

The `AND` and `OR` cases are written to keep `'UNKNOWN'` from being mistaken for a definite answer:

```typescript
if (op === 'AND') {
  if (left === false || right === false) return false;
  if (left === null || right === null) return null;
  if (left === 'UNKNOWN' || right === 'UNKNOWN') return 'UNKNOWN';
  return true;
}
```

Any other binary operator returns `null` if either operand is `null`, and `'UNKNOWN'` otherwise. That single line is what makes `o.O_TOTALPRICE > 50` null-rejecting: the left operand is `null`, so the comparison is `null`, so the predicate is not true.

`IS NULL` is the interesting case, and it is handled explicitly:

```typescript
case BoundExprKind.IS_NULL: {
  const operand = evaluateWithNulls(expr.expr, nullRefs);
  if (operand === 'UNKNOWN' || operand === undefined) return 'UNKNOWN';
  return expr.negated ? operand !== null : operand === null;
}
```

`o.O_ORDERKEY IS NULL` evaluates to `true` when the right side supplies nulls, so it is *not* null-rejecting. That is the whole reason the anti-join idiom works.

The `nullSupplyingRefs` argument is either a set of aliases and column names from [`collectPlanRefs`](../../src/optimizer/passes/plan-refs.ts) or a predicate function, resolved by [`suppliesNull`](../../src/optimizer/passes/null-rejection.ts). The two callers use it differently: predicate pushdown asks about one specific subtree, and the pass below asks about each side of a join in turn.

## Weakening outer joins

[`OuterToInnerJoin`](../../src/optimizer/passes/outer-to-inner.ts) is a single rewrite: a `Filter` whose child is a `LEFT`, `RIGHT`, `FULL`, or `SINGLE` join. It computes two booleans over the filter's conjuncts —

```typescript
for (const pred of predicates) {
  if (isNullRejecting(pred, rightRefs)) rejectRightNulls = true;
  if (isNullRejecting(pred, leftRefs))  rejectLeftNulls = true;
}
```

— and then rewrites the join type:

| Join type | Condition | Becomes |
|---|---|---|
| `LEFT` | rejects right nulls | `INNER` |
| `SINGLE` | rejects right nulls | `INNER` |
| `RIGHT` | rejects left nulls | `INNER` |
| `FULL` | rejects both | `INNER` |
| `FULL` | rejects left only | `LEFT` |
| `FULL` | rejects right only | `RIGHT` |

Chapter 17 showed the `LEFT` case, where predicate pushdown does the demotion itself as a side effect of moving a right-only predicate down. This pass exists for the cases pushdown does not cover: it demotes without moving anything, so it fires on predicates that *cannot* move — ones spanning both sides, or ones stranded above a join that is not the filter's immediate concern.

The `FULL` rows are the ones worth seeing, because a partial demotion is not a shape most people expect. One filter on the left input:

```sql
SELECT c.C_NAME FROM CUSTOMER c FULL OUTER JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE c.C_MKTSEGMENT = 'BUILDING'
```

```
BEFORE                                          AFTER
-> Filter (condition:                           -> Filter (condition:
     (C.C_MKTSEGMENT = 'BUILDING'))                  (C.C_MKTSEGMENT = 'BUILDING'))
  -> FULL Join (condition:                        -> LEFT Join (condition:
       (C.C_CUSTKEY = O.O_CUSTKEY))                     (C.C_CUSTKEY = O.O_CUSTKEY))
    -> Seq Scan on CUSTOMER as C                    -> Seq Scan on CUSTOMER as C
    -> Seq Scan on ORDERS as O                      -> Seq Scan on ORDERS as O
```

Derive it. A `FULL` join emits three kinds of row: matched pairs, left rows padded on the right, and right rows padded on the left. The predicate mentions only `CUSTOMER` columns and is null-rejecting on them, so every row of the third kind is discarded by the filter anyway. Removing them from the join's output changes nothing — and a `FULL` join that does not emit unmatched right rows is a `LEFT` join.

Add a null-rejecting predicate on the other side too and both directions collapse:

```sql
WHERE c.C_MKTSEGMENT = 'BUILDING' AND o.O_TOTALPRICE > 5
```

```
-> Filter (condition: ((C.C_MKTSEGMENT = 'BUILDING') AND (O.O_TOTALPRICE > 5)))
  -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
```

And the anti-join idiom is left alone, because `IS NULL` is not null-rejecting:

```sql
SELECT c.C_NAME FROM CUSTOMER c LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE o.O_ORDERKEY IS NULL
```

```
-> Filter (condition: (O.O_ORDERKEY IS NULL))
  -> LEFT Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
```

Why does the demotion matter? An inner join has more freedom than an outer one everywhere downstream: it can be reordered ([chapter 25](25-join-ordering.md) only enumerates inner joins), its predicates can be inferred across (the early return above), and its inputs can be filtered independently. Demoting a join is not a small local win; it unlocks the rest of the optimizer.

## In the code

| Idea | Where |
|---|---|
| Inference pass | [`PredicateInference`](../../src/optimizer/passes/predicate-inference.ts) |
| Derivation rules | [`inferNewPredicates`](../../src/optimizer/passes/predicate-inference.ts) |
| Limited visibility into the plan | [`collectFiltersAbove`](../../src/optimizer/passes/predicate-inference.ts) |
| `IN` lists from `OR` | [`inferInListsFromOr`](../../src/optimizer/passes/predicate-inference.ts) |
| Ranges from `OR` | [`inferRangePredicatesFromOr`](../../src/optimizer/passes/predicate-inference.ts) |
| Duplicate suppression | [`predKey`](../../src/optimizer/passes/predicate-inference.ts) |
| Null-rejection test | [`isNullRejecting`](../../src/optimizer/passes/null-rejection.ts) |
| Four-valued interpreter | [`evaluateWithNulls`](../../src/optimizer/passes/null-rejection.ts) |
| Outer-join weakening | [`OuterToInnerJoin`](../../src/optimizer/passes/outer-to-inner.ts) |
| Which columns a subtree supplies | [`collectPlanRefs`](../../src/optimizer/passes/plan-refs.ts) |

## Traps

**Inference on its own does nothing to an unoptimized plan.** It reads only a join's condition and its immediate `Filter` children. Testing it in isolation without running pushdown first will convince you it is broken.

**The inferred predicate is added, not substituted.** `WHERE c.C_CUSTKEY = 42` keeps its filter and gains a sibling on the other input. Both are evaluated; that is the intent.

**Ranges and `IN` lists derived from an `OR` are weaker than the `OR`.** They cannot replace it, and the plan will look redundant. It is redundant, on purpose — the point is to hand a simple single-column constraint to the scan.

**`'UNKNOWN'` is a fourth value, not a null.** A predicate over a `CASE` expression, a function call, or a cast evaluates to `'UNKNOWN'` and is therefore treated as *not* null-rejecting, so a `LEFT JOIN` filtered by `WHERE UPPER(o.O_ORDERSTATUS) = 'F'` keeps its outer-ness. That is conservative and safe, and it is also a missed optimization.

**Column matching is by uppercased alias, and falls back to column name.** [`suppliesNull`](../../src/optimizer/passes/null-rejection.ts) checks a reference's `tableAlias` against the subtree's alias set, and when the reference has no alias it checks the column *name* against the subtree's column names instead. Two relations exposing the same column name are then indistinguishable on that path. [Chapter 8](../01-frontend/08-binder-scopes-and-names.md) explains how the binder's alias uniqueness keeps bound references qualified in the first place.

## Exercises

1. Confirm the opening result three ways: inference alone (no change), pushdown then inference (both filters), and the full pipeline. Use the observer to see which stage and iteration each change happens in.

2. Write a query where inference derives a `<` on a table you never filtered, and one where it derives nothing because the join predicate is `c.C_CUSTKEY = o.O_CUSTKEY + 1`. Explain the second from `inferNewPredicates`.

3. Make `collectFiltersAbove` search the whole subtree rather than one node. Show that the chapter-15 divergence disappears, then find a query where the change makes inference derive something new.

4. `evaluateWithNulls` returns `'UNKNOWN'` for `BoundExprKind.CAST`. Add a case that recurses into the cast's operand instead, then find a `LEFT JOIN` query whose plan improves and argue that the change is sound.

5. Delete the `FULL` branch of `OuterToInnerJoin` and run `npm run test:e2e`. Does anything fail? If not, write the query that should have.

## Recap

- [`PredicateInference`](../../src/optimizer/passes/predicate-inference.ts) derives new predicates from **transitivity across equalities** — constants and comparisons — and from **common constraints across `OR` branches**, as `IN` lists and range bounds.
- It reads only a join's condition and its **immediate `Filter` children**, so it depends on pushdown having run first. That dependency is why the two share a fixpoint stage.
- Derived `OR` constraints are **necessary but not sufficient**; the original disjunction stays, and the derivation exists to hand a simple range to the scan.
- Inference is restricted to **inner joins**, because an outer join's condition does not hold for its padded rows.
- [`isNullRejecting`](../../src/optimizer/passes/null-rejection.ts) evaluates a predicate over four values — `true`, `false`, `null`, and `'UNKNOWN'` — and asks whether the result can be true when the named columns are null.
- [`OuterToInnerJoin`](../../src/optimizer/passes/outer-to-inner.ts) uses that answer to demote joins: `LEFT`, `RIGHT`, and `SINGLE` to `INNER`, and `FULL` to `INNER`, `LEFT`, or `RIGHT` depending on which side is rejected. `IS NULL` is not null-rejecting, which is what keeps the anti-join idiom working.

Next: [chapter 19](19-projection-limit-and-cleanup.md) covers the passes that trim the plan rather than restructure it — including two whose work the plan printer does not show you.
