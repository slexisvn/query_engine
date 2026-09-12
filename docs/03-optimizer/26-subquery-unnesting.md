# 26. Subquery unnesting

> After this chapter you will be able to name the join type any subquery becomes, and derive SQL's `NOT IN` surprise from the one field that distinguishes it from `NOT EXISTS`.

## The question

Two ways of asking "which customers have no orders", over an `ORDERS` table whose `O_CUSTKEY` column holds the values `1` and `NULL`:

```sql
SELECT c.C_NAME FROM CUSTOMER c WHERE c.C_CUSTKEY NOT IN (SELECT o.O_CUSTKEY FROM ORDERS o)
SELECT c.C_NAME FROM CUSTOMER c WHERE NOT EXISTS (SELECT 1 FROM ORDERS o WHERE o.O_CUSTKEY = c.C_CUSTKEY)
```

```
NOT IN     -> []
NOT EXISTS -> ["Bob","Carol"]
```

Three customers, keys 1, 2, and 3. `NOT EXISTS` gives the answer you expected. `NOT IN` gives nothing at all — not even for customers whose key appears nowhere in the subquery.

This is usually taught as "beware nulls with `NOT IN`". It is also visible directly in the plan, because the two queries are compiled into **different join types**, and the difference is one boolean field in a table of five entries.

## Dependent joins

Before the optimizer sees anything, the planner has already turned every subquery into a node. [Chapter 12](../02-logical-plan/12-building-the-plan.md) built it: a `Dependent Join` whose left child is the outer query and whose right child is the subquery's plan, tagged with a `SubqueryType`.

```
SELECT c.C_NAME FROM CUSTOMER c WHERE EXISTS (SELECT 1 FROM ORDERS o WHERE o.O_CUSTKEY = c.C_CUSTKEY)

-> Project (C.C_NAME)
  -> Dependent Join (EXISTS)
    -> Seq Scan on CUSTOMER as C
    -> Project (1)
      -> Filter (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
        -> Seq Scan on ORDERS as O
```

Read that filter carefully. `C.C_CUSTKEY` appears inside the subquery's plan, referring to a column the subquery's own `FROM` clause does not provide. [Chapter 8](../01-frontend/08-binder-scopes-and-names.md) showed how the binder marks such a reference — `depth > 0` and `isCorrelated` — and the whole of this chapter and the next exists to remove it.

The node is not executable. Run the plan directly and you get:

```
Correlated EXISTS subquery reached execution without being decorrelated;
SubqueryUnnesting is required for correctness
```

`SubqueryUnnesting` is the only pass in the pipeline whose absence makes queries fail rather than run slowly.

## Five shapes

[`SUBQUERY_JOINS`](../../src/optimizer/passes/subquery-unnesting.ts) is a table from subquery type to a small description of the join it becomes:

```typescript
const SUBQUERY_JOINS: Record<SubqueryType, SubqueryJoinShape> = {
  [SubqueryType.EXISTS]:     { ...PASSTHROUGH_SHAPE, joinType: constantJoin(JoinType.SEMI),  comparesOuter: false },
  [SubqueryType.NOT_EXISTS]: { ...PASSTHROUGH_SHAPE, joinType: constantJoin(JoinType.ANTI),  comparesOuter: false },
  [SubqueryType.IN]:         { ...PASSTHROUGH_SHAPE, joinType: constantJoin(JoinType.SEMI),  comparesOuter: true },
  [SubqueryType.MARK]:       { ...PASSTHROUGH_SHAPE, joinType: constantJoin(JoinType.MARK),  comparesOuter: true,
                               carriesMark: true, distinguishesUnknown: true },
  [SubqueryType.SCALAR]:     { joinType: scalarJoinType, comparesOuter: false, projectsScalar: true,
                               carriesMark: false, distinguishesUnknown: false },
};
```

Four flags describe what the rewrite has to do beyond picking a join type:

| Flag | Meaning |
|---|---|
| `comparesOuter` | the outer expression must be compared against the subquery's output |
| `projectsScalar` | the subquery's first output column becomes a named value on the outer row |
| `carriesMark` | the join emits a three-valued marker column |
| `distinguishesUnknown` | `true`, `false`, and `unknown` must stay distinct |

And here is each one, run in isolation.

**`EXISTS` becomes a semi join.** A semi join emits each left row at most once, when a match exists:

```
BEFORE                                          AFTER
-> Dependent Join (EXISTS)                      -> SEMI Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
  -> Seq Scan on CUSTOMER as C                    -> Seq Scan on CUSTOMER as C
  -> Project (1)                                  -> Project (1, O.O_CUSTKEY)
    -> Filter (condition:                           -> Seq Scan on ORDERS as O
         (O.O_CUSTKEY = C.C_CUSTKEY))
      -> Seq Scan on ORDERS as O
```

Three things moved. The filter is gone from inside the subquery and has become the join condition; the projection gained `O.O_CUSTKEY` so the join has a column to compare; and the correlation is no longer a correlation, because both sides of `O.O_CUSTKEY = C.C_CUSTKEY` are now provided by the join's own inputs. That relocation is chapter 27's subject.

**`NOT EXISTS` becomes an anti join** — the same rewrite with the complementary join type:

```
-> ANTI Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
  -> Seq Scan on CUSTOMER as C
  -> Project (1, O.O_CUSTKEY)
    -> Seq Scan on ORDERS as O
```

**`IN` becomes a semi join with a manufactured condition.** `comparesOuter` is true, so the pass builds a comparison between the outer expression and the subquery's first output column:

```typescript
if (shape.comparesOuter && node.condition && outputRef) {
  conditions.push(BoundBinary(node.compareOp, node.condition, outputRef, DataType.BOOLEAN));
}
```

```
BEFORE                                          AFTER
-> Dependent Join (IN)                          -> SEMI Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
  -> Seq Scan on CUSTOMER as C                    -> Seq Scan on CUSTOMER as C
  -> Project (O.O_CUSTKEY)                        -> Seq Scan on ORDERS as O
    -> Seq Scan on ORDERS as O
```

`node.compareOp` is where `ANY` and `ALL` are handled. `> ANY` is `IN` with `>`; `ALL` is negated, so it takes the mark path with the complementary operator:

```
WHERE c.C_CUSTKEY > ANY (SELECT o.O_CUSTKEY FROM ORDERS o)
-> SEMI Join (condition: (C.C_CUSTKEY > O.O_CUSTKEY))

WHERE c.C_CUSTKEY < ALL (SELECT o.O_CUSTKEY FROM ORDERS o)
-> Filter (condition: NOT __mark_0)
  -> MARK Join (condition: (C.C_CUSTKEY >= O.O_CUSTKEY))
```

**Scalar subqueries become one of two joins**, chosen by a function rather than a constant:

```typescript
function scalarJoinType(subquery: LogicalPlanNode): JoinType {
  return hasAggregate(subquery) ? JoinType.LEFT : JoinType.SINGLE;
}
```

A subquery containing an aggregate produces at most one row per group by construction, so a `LEFT` join is safe and enables everything in chapters 17 through 25. A subquery without one has no such guarantee, so it gets a `SINGLE` join instead: [`probeJoinInto`](../../src/execution/operators/join-core.ts) emits every probe row exactly once, taking the **first** match it finds and `break`ing out of the build-side loop, and padding with nulls when there is none. Where SQL specifies an error for a scalar subquery returning several rows, this engine takes one of them.

```
(SELECT MAX(o.O_ORDERKEY) FROM ORDERS o WHERE o.O_CUSTKEY = c.C_CUSTKEY)

-> LEFT Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
  -> Seq Scan on CUSTOMER as C
  -> Project (MAX(O.O_ORDERKEY), O.O_CUSTKEY)
    -> Aggregate (group by: O.O_CUSTKEY) (aggs: MAX(O.O_ORDERKEY))
      -> Seq Scan on ORDERS as O
```

```
(SELECT o.O_ORDERKEY FROM ORDERS o WHERE o.O_CUSTKEY = c.C_CUSTKEY)

-> SINGLE Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
  -> Seq Scan on CUSTOMER as C
  -> Project (O.O_ORDERKEY, O.O_CUSTKEY)
    -> Seq Scan on ORDERS as O
```

Note also what the aggregate gained: `GROUP BY O.O_CUSTKEY`. The subquery computed one maximum per outer customer; the rewritten form computes all of them at once, grouped. That is the transformation that makes decorrelation worth doing — one pass over `ORDERS` instead of one per customer.

`projectScalarOutput` names the first projected expression with `node.markColumn`, so the outer `Project` can keep referring to it as `_scalar_0`.

## Why `NOT IN` is different

Now the opening. `NOT IN` does not map to `ANTI`. The planner emits a `MARK` dependent join wrapped in a `NOT`:

```
BEFORE                                          AFTER
-> Filter (condition: NOT __mark_0)             -> Filter (condition: NOT __mark_0)
  -> Dependent Join (MARK)                        -> MARK Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
    -> Seq Scan on CUSTOMER as C                    -> Seq Scan on CUSTOMER as C
    -> Project (O.O_CUSTKEY)                        -> Seq Scan on ORDERS as O
      -> Seq Scan on ORDERS as O
```

A **mark join** emits every left row exactly once with an extra boolean column — `__mark_0` — that is `true` when a match was found, `false` when none was, and **`NULL` when the answer is unknown**: no match was found, but the comparison against some right row evaluated to `NULL`.

That third value is the whole story. `x NOT IN (1, NULL)` in SQL is:

- `x = 1` is `false`, `x = NULL` is `NULL`
- so `x IN (...)` is `false OR NULL` = `NULL`
- so `NOT (x IN (...))` is `NOT NULL` = `NULL`
- and `WHERE NULL` keeps no rows

An anti join cannot express that, because it has only two outcomes: matched or not. So the planner keeps the mark, and the `NOT` is applied by an ordinary filter using ordinary three-valued logic. Every customer whose key does not equal `1` gets `__mark_0 = NULL` because of the `NULL` in the column, `NOT NULL` is `NULL`, and every row is filtered away. That is the empty result at the top of this chapter, derived rather than memorized.

`distinguishesUnknown` is the flag that carries this into the decorrelation machinery. It is `true` only for `MARK`, and chapter 27 shows what it changes: predicates lifted out of the subquery are wrapped in [`definitelyTrue`](../../src/optimizer/dependent-join/domain.ts), and the domain join-back is made null-safe unconditionally. Both exist so that "unknown" cannot be silently converted into "false" somewhere in the rewrite.

The practical advice — write `NOT EXISTS`, or add `WHERE x IS NOT NULL` to the subquery — falls out. `NOT EXISTS` compiles to an anti join with two outcomes and no null hazard.

## Running to a fixpoint

[`SubqueryUnnesting.apply`](../../src/optimizer/passes/subquery-unnesting.ts) is a loop:

```typescript
let current = plan;
let changed = true;
while (changed) {
  const rewriter = new UnnestingRewriter();
  current = rewriter.rewrite(current);
  changed = rewriter.didChange;
}
```

This is the only pass with its own internal fixpoint — [chapter 15](15-passes-and-fixpoints.md)'s `registerFixpoint` is not used for it, and there is no iteration cap. It is needed because unnesting one dependent join can expose another: a subquery containing a subquery produces a nested `Dependent Join`, and the rewriter processes one nesting level per sweep.

The loop terminates because each sweep replaces at least one `Dependent Join` with a plain join and never creates one.

## Two errors it can raise

The pass throws rather than producing a wrong plan in two cases.

A correlating column that is read only through a CTE is rejected by [`correlationHiddenFromPlan`](../../src/optimizer/dependent-join/correlation.ts):

```
Unsupported correlated subquery: a common table expression reads the correlating column C.C_CUSTKEY
```

A CTE's body is planned once and shared, so it cannot be parameterized by the outer row. Detection is deliberately coarse — the check only fires when a `CTE_SCAN` is present *and* some correlating column was never reached in the visible plan.

Chapter 27 lists the rest, all raised from the pushdown machinery.

## In the code

| Idea | Where |
|---|---|
| The pass and its internal fixpoint | [`SubqueryUnnesting`](../../src/optimizer/passes/subquery-unnesting.ts) |
| The shape table | [`SUBQUERY_JOINS`](../../src/optimizer/passes/subquery-unnesting.ts) |
| Scalar join-type choice | [`scalarJoinType`](../../src/optimizer/passes/subquery-unnesting.ts) |
| Naming the scalar output | [`projectScalarOutput`](../../src/optimizer/passes/subquery-unnesting.ts) |
| Finding the subquery's output column | [`subqueryOutputRef`](../../src/optimizer/passes/subquery-unnesting.ts) |
| CTE correlation rejection | [`correlationHiddenFromPlan`](../../src/optimizer/dependent-join/correlation.ts) |
| Which columns correlate | [`CorrelationSet`](../../src/optimizer/dependent-join/correlation.ts) |
| Choosing how to decorrelate | [`chooseDomain`](../../src/optimizer/dependent-join/domain-choice.ts) |
| Doing it | [`pushDependentJoin`](../../src/optimizer/dependent-join/pushdown.ts) |

## Traps

**`NOT IN` and `NOT EXISTS` are not the same query.** They compile to different join types because they mean different things when nulls are present. No optimizer pass will convert one into the other.

**A `SINGLE` join takes the first match rather than raising.** A scalar subquery without an aggregate that matches two rows returns one of them, chosen by build-side order. The standard calls for an error; the operator `break`s.

**`SubqueryUnnesting` is exempted from the ablation invariant.** [Chapter 28](28-plan-properties-and-ablation.md) shows the differential test skipping it by name: removing it does not make queries slower, it makes them fail.

**The correlated filter moves into the join condition, so it is no longer subject to predicate pushdown as a filter.** It becomes part of a join and is then handled by [chapter 17](17-predicate-pushdown.md)'s `pushJoinConditionPredicates` on the second pushdown run.

**The mark column name is generated by the binder, not the pass.** `__mark_0` is bound before optimization; the pass copies it onto the join with `{ ...join, markColumn: node.markColumn }`.

## Exercises

1. Reproduce the opening result. Register `ORDERS` with an explicit schema so `O_CUSTKEY` is nullable, put a `NULL` in it, and run both queries. Then add `WHERE o.O_CUSTKEY IS NOT NULL` to the `NOT IN` subquery and confirm the answers converge.

2. Print the plan for each of the five subquery types with only `SubqueryUnnesting` registered. For each, say which of the four shape flags was responsible for the difference from the plain `EXISTS` case.

3. Write a scalar subquery that matches two rows for one outer row and confirm which one comes back. Then add `MAX(...)` around the projection and watch the join type change from `SINGLE` to `LEFT`.

4. Nest a correlated `EXISTS` inside another correlated `EXISTS` and instrument `SubqueryUnnesting.apply` to count sweeps. How many does it take, and how does that scale with nesting depth?

5. Remove the `distinguishesUnknown` flag from the `MARK` entry and run `tests/e2e/subquery-unnesting-differential.test.ts`. Which query in the corpus catches you?

## Recap

- The planner emits a **`Dependent Join`** for every subquery; it is not executable, and the operator says so by name when reached.
- [`SUBQUERY_JOINS`](../../src/optimizer/passes/subquery-unnesting.ts) maps five subquery types to join types: `EXISTS` → **semi**, `NOT EXISTS` → **anti**, `IN` → **semi with a manufactured comparison**, `NOT IN` and `ALL` → **mark**, scalar → **left** with an aggregate and **single** without. A `SINGLE` join keeps the first match rather than erroring on several.
- Four flags handle the rest: comparing the outer expression, projecting a scalar output, carrying the mark column, and preserving unknown.
- `NOT IN` needs a **three-valued mark** because `NOT (x IN (…, NULL))` is `NULL`, not `true`. An anti join has only two outcomes, so it cannot be used, and that is why `NOT IN` returns nothing when the subquery contains a null.
- A correlated scalar subquery with an aggregate becomes a **grouped** aggregate joined once, rather than an aggregate evaluated per outer row.
- The pass runs its **own uncapped fixpoint**, because unnesting one dependent join can expose another.

Next: [chapter 27](27-dependent-joins-and-decorrelation.md) covers the part this chapter skipped — how the correlated predicate actually gets out of the subquery, and what happens when it cannot.
