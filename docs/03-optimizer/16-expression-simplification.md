# 16. Expression simplification

> After this chapter you will be able to predict which expressions the optimizer rewrites, and explain why moving one `AND` outside an `OR` is what lets the next pass push a filter through a join.

## The question

Two queries that any SQL user would call the same thing:

```sql
SELECT c.C_NAME FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE (c.C_MKTSEGMENT = 'BUILDING' AND o.O_TOTALPRICE > 100)
   OR (c.C_MKTSEGMENT = 'BUILDING' AND o.O_ORDERSTATUS = 'F')
```

```sql
SELECT c.C_NAME FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE c.C_MKTSEGMENT = 'BUILDING'
  AND (o.O_TOTALPRICE > 100 OR o.O_ORDERSTATUS = 'F')
```

Run predicate pushdown on the first one, alone, and it can do almost nothing:

```
-> Project (C.C_NAME)
  -> Join (condition: ((C.C_CUSTKEY = O.O_CUSTKEY) AND (((C.C_MKTSEGMENT = 'BUILDING') AND (O.O_TOTALPRICE > 100)) OR ((C.C_MKTSEGMENT = 'BUILDING') AND (O.O_ORDERSTATUS = 'F')))))
    -> Seq Scan on CUSTOMER as C
    -> Seq Scan on ORDERS as O
```

Both scans run in full and the whole disjunction is evaluated on every candidate pair. Put `ExpressionSimplifier` in front of exactly the same pushdown pass and you get this instead:

```
-> Project (C.C_NAME)
  -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
    -> Filter (condition: (C.C_MKTSEGMENT = 'BUILDING'))
      -> Seq Scan on CUSTOMER as C
    -> Filter (condition: ((O.O_TOTALPRICE > 100) OR (O.O_ORDERSTATUS = 'F')))
      -> Seq Scan on ORDERS as O
```

Both scans are now filtered before the join sees them. Pushdown did not get smarter. One function turned the first query's `WHERE` clause into the second's, and pushdown's existing rules did the rest.

## Why the first pass is this pass

[`ExpressionSimplifier`](../../src/optimizer/passes/expression-simplifier.ts) is the first registration in [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts), before subquery unnesting and before the predicate fixpoint. That placement is the point of the pass.

Predicate pushdown, the subject of [chapter 17](17-predicate-pushdown.md), reasons about [conjuncts](../01-frontend/09-types-and-expressions.md). A predicate that is one big `OR` at the top has exactly one conjunct, and if that conjunct mentions both sides of a join it cannot move. Everything downstream in the optimizer works on conjuncts, so anything that increases the number of top-level conjuncts increases what every later pass can do.

That is the job. Simplification here is not primarily about saving arithmetic at runtime; it is about putting expressions into a shape the rest of the pipeline can act on.

## Where it looks

[`SimplifierRewriter`](../../src/optimizer/passes/expression-simplifier.ts) overrides exactly three node types: `Filter` conditions, `Project` expressions, and `Join` conditions. Every other expression in the plan is left alone.

That is observable. Simplify a query that computes the same expression in the select list and in `ORDER BY`:

```
-> Project (CUSTOMER.C_CUSTKEY)
  -> Sort ((CUSTOMER.C_CUSTKEY + 0) ASC)
    -> Seq Scan on CUSTOMER as CUSTOMER
```

`C_CUSTKEY + 0` in the projection became `C_CUSTKEY`. The identical expression in the sort key did not, because `rewriteSort` is not overridden. The same is true of `GROUP BY` keys:

```
-> Project (SUM(CUSTOMER.C_NATIONKEY))
  -> Aggregate (group by: (CUSTOMER.C_CUSTKEY * 1)) (aggs: SUM(CUSTOMER.C_NATIONKEY))
    -> Seq Scan on CUSTOMER as CUSTOMER
```

This is not only a missed micro-optimization. Sort keys are compared by expression identity elsewhere in the optimizer — [`satisfiesOrder`](../../src/planner/sort-properties.ts) in chapter 21 decides whether an existing ordering satisfies a required one by matching column references — and an unsimplified `(C_CUSTKEY + 0)` is not a column reference at all.

## Constant folding

[`simplifyExpression`](../../src/optimizer/passes/expression-simplifier.ts) recurses to the leaves and rebuilds bottom-up. When both operands of a binary node are literals, it evaluates:

```
WHERE C_CUSTKEY > 2 + 3 * 4
  before: Filter (condition: (CUSTOMER.C_CUSTKEY > (2 + (3 * 4))))
  after:  Filter (condition: (CUSTOMER.C_CUSTKEY > 14))
```

`CAST` of a literal folds through [`foldCast`](../../src/optimizer/passes/expression-simplifier.ts):

```
SELECT CAST('42' AS INTEGER) FROM CUSTOMER
  before: Project (<BoundCast>)
  after:  Project (42)
```

`EXTRACT` from a literal date folds through [`extractFromDate`](../../src/optimizer/passes/expression-simplifier.ts). A `CASE` whose branch condition folds to `true` collapses to that branch's result, and one whose conditions all fold to `false` collapses to the `ELSE`:

```
SELECT CASE WHEN 1 = 1 THEN C_NAME ELSE 'x' END FROM CUSTOMER
  before: Project (<BoundCase>)
  after:  Project (CUSTOMER.C_NAME)
```

Those `<BoundCast>` and `<BoundCase>` renderings are the formatter's, not the pass's — chapter 13 explains that [`formatExpression`](../../src/planner/plan-formatter.ts) knows how to print only seven of the eighteen expression kinds. Folding is one of the few places where the plan gets *more* readable.

Folding is guarded on nulls:

```typescript
if (lVal !== null && rVal !== null) {
  ...
}
```

Without that, `NULL + 1` would fold to `1` in JavaScript arithmetic and quietly break three-valued logic.

## Algebraic identities

The arithmetic rules are deliberately one-sided:

```typescript
if (op === '+' || op === '-') {
  if (isLiteral(right, 0)) return left;
  if (op === '+' && isLiteral(left, 0)) return right;
}
if (op === '*') {
  if (isLiteral(right, 1)) return left;
  if (isLiteral(left, 1)) return right;
}
if (op === '/') {
  if (isLiteral(right, 1)) return left;
}
```

`x + 0`, `0 + x`, `x - 0`, `x * 1`, `1 * x`, and `x / 1` all collapse to `x`. `0 - x` and `1 / x` do not, and must not: subtraction and division are not commutative, so the identity does not hold on the left. Chained, they compose:

```
SELECT C_CUSTKEY * 1 + 0 FROM CUSTOMER
  before: Project (((CUSTOMER.C_CUSTKEY * 1) + 0))
  after:  Project (CUSTOMER.C_CUSTKEY)
```

The boolean rules are where [three-valued logic](../01-frontend/09-types-and-expressions.md) has to be respected, and reading them as SQL rather than as boolean algebra is worth the minute:

| Rule | Why it is sound with nulls |
|---|---|
| `false AND x` → `false` | `FALSE AND NULL` is `FALSE` in SQL |
| `true AND x` → `x` | identity in all three values |
| `true OR x` → `true` | `TRUE OR NULL` is `TRUE` |
| `false OR x` → `x` | identity in all three values |
| `x AND x` → `x`, `x OR x` → `x` | idempotent for `TRUE`, `FALSE`, and `NULL` alike |
| `NOT NOT x` → `x` | `NOT NULL` is `NULL`, so double negation is identity |

The idempotence rules use [`exprEquals`](../../src/optimizer/passes/expression-simplifier.ts), which special-cases column references and literals and otherwise falls back to [`exprKey`](../../src/binder/expr-key.ts), the canonical string form of an expression used throughout the optimizer. So this collapses:

```
WHERE C_CUSTKEY > 5 AND C_CUSTKEY > 5
  -> Filter (condition: (CUSTOMER.C_CUSTKEY > 5))
```

## Factoring conjuncts out of a disjunction

Now the opening. The `OR` case has one more rule than the `AND` case:

```typescript
const factored = factorCommonConjuncts(left, right);
if (factored) return simplifyExpression(factored);
```

[`factorCommonConjuncts`](../../src/optimizer/passes/expression-simplifier.ts) splits both sides of the `OR` into conjuncts, keys them with `exprKey`, and finds the intersection. If there is any, it rebuilds the expression as `common AND (leftRest OR rightRest)`:

```typescript
const leftRemainder = combineConjuncts(leftRest) || BoundLiteral(true, DataType.BOOLEAN);
const rightRemainder = combineConjuncts(rightRest) || BoundLiteral(true, DataType.BOOLEAN);
const residualOr: BoundBinaryNode = { kind: BoundExprKind.BINARY, op: 'OR',
  left: leftRemainder, right: rightRemainder, resultType: DataType.BOOLEAN };
return combineConjuncts([...common, residualOr]);
```

This is the distributive law of boolean algebra, `(a ∧ b) ∨ (a ∧ c) ≡ a ∧ (b ∨ c)`, run in the direction that *reduces* the number of `OR`s at the top. On a single table it looks like a tidy-up:

```
WHERE (C_MKTSEGMENT = 'BUILDING' AND C_CUSTKEY > 10)
   OR (C_MKTSEGMENT = 'BUILDING' AND C_NATIONKEY = 3)

  before: Filter (condition: (((CUSTOMER.C_MKTSEGMENT = 'BUILDING') AND (CUSTOMER.C_CUSTKEY > 10)) OR ((CUSTOMER.C_MKTSEGMENT = 'BUILDING') AND (CUSTOMER.C_NATIONKEY = 3))))
  after:  Filter (condition: ((CUSTOMER.C_MKTSEGMENT = 'BUILDING') AND ((CUSTOMER.C_CUSTKEY > 10) OR (CUSTOMER.C_NATIONKEY = 3))))
```

Across a join it is the difference between two full scans and two filtered ones, which is the plan at the top of this chapter. One conjunct became two; one of them mentions only `CUSTOMER` and one only `ORDERS`, and pushdown's existing left/right/both routing sends each to its side.

Note the recursion: `factorCommonConjuncts` returns an expression that is fed back through `simplifyExpression`, so a residual `OR` that itself has common conjuncts gets factored again.

The remainder guard matters too. If one branch of the `OR` is *entirely* common — `(a AND b) OR a` — its remainder is empty, `combineConjuncts` returns `null`, and the literal `true` stands in. The next round of simplification sees `true OR b`, rewrites it to `true`, and then `a AND true` becomes `a`. The redundant branch disappears without a rule that mentions it.

## Deleting and short-circuiting filters

[`rewriteFilter`](../../src/optimizer/passes/expression-simplifier.ts) does two things after simplifying its condition. If the condition folded to `true`, the `Filter` node is dropped entirely and its child is returned. If it folded to `false`, the filter is replaced by an `Empty` node:

```typescript
if (simplifiedCond && simplifiedCond.kind === BoundExprKind.LITERAL && simplifiedCond.value === false) {
  const empty: LogicalEmptyNode = { type: PlanNodeType.EMPTY, children: [child] };
  return empty;
}
```

```
SELECT C_NAME FROM CUSTOMER WHERE 1 = 2
  before: Filter (condition: (1 = 2))
            Seq Scan on CUSTOMER as CUSTOMER
  after:  Empty (short-circuit)
            Seq Scan on CUSTOMER as CUSTOMER
```

Read the `after` carefully: the scan is still there, as a child of `Empty`. Nothing has been deleted yet — the node has only been *marked*. Propagating the emptiness upward and cutting the dead subtree loose is a different pass, `EmptyPropagation`, and [chapter 19](19-projection-limit-and-cleanup.md) shows a query where it deliberately refuses to.

## In the code

| Idea | Where |
|---|---|
| The pass | [`ExpressionSimplifier`](../../src/optimizer/passes/expression-simplifier.ts) |
| Which nodes it visits | [`SimplifierRewriter`](../../src/optimizer/passes/expression-simplifier.ts) |
| The rewrite rules | [`simplifyExpression`](../../src/optimizer/passes/expression-simplifier.ts) |
| Distributive factoring | [`factorCommonConjuncts`](../../src/optimizer/passes/expression-simplifier.ts) |
| Literal cast folding | [`foldCast`](../../src/optimizer/passes/expression-simplifier.ts) |
| Expression identity | [`exprEquals`](../../src/optimizer/passes/expression-simplifier.ts), [`exprKey`](../../src/binder/expr-key.ts) |
| Splitting and rebuilding `AND` | [`splitConjuncts`](../../src/binder/conjuncts.ts), [`combineConjuncts`](../../src/binder/conjuncts.ts) |

## Traps

**Only three node types are visited.** Sort keys, group-by keys, aggregate arguments, limit counts, and dependent-join correlations keep whatever expression the binder produced. If you are debugging why a sort was not eliminated, check whether its key is literally a column reference.

**Folding an integer pair can change the literal's declared type.** For `+`, `-`, and `*` the folded literal is typed `FLOAT64` whenever JavaScript's result is a `number`, which for two `INT32` operands it always is. The value is right and the engine's own arithmetic is double-based anyway ([chapter 9](../01-frontend/09-types-and-expressions.md) covers why `5 / 2` is `2.5` here), but a plan reader expecting `INT32` will be surprised.

**Folding is done with JavaScript operators.** String literals compare lexicographically, which matches SQL for `VARCHAR`, and division by a literal zero yields JavaScript's `Infinity` rather than an error or a null. `SELECT 1/0 AS X` folds to a `FLOAT64` literal whose value is `Infinity`, and that is the value the row carries — it only *looks* like `null` because `JSON.stringify` renders it that way.

**`factorCommonConjuncts` only looks at the top level of each branch.** `(a AND (b AND c)) OR (a AND d)` factors because `splitConjuncts` flattens nested `AND`s, but `(a OR b) AND c` on one side and `a` on the other share nothing at conjunct level, and nothing is factored.

**An empty filter is not a removed filter.** `Empty (short-circuit)` keeps its child so the plan is still well-formed and printable; only `EmptyPropagation` decides what happens to the subtree underneath.

## Exercises

1. Reproduce the two plans from the opening. Build one optimizer with only `PredicatePushdown` and one with `ExpressionSimplifier` followed by `PredicatePushdown`, and diff their output.

2. Write a `WHERE` clause with three `OR` branches that share two conjuncts, and predict the factored form before running it. Then add a fourth branch that shares only one, and predict again.

3. Add `rewriteSort` to `SimplifierRewriter` so order keys are simplified too. Run `npm run test:unit`; then find a query where the change lets `SortElimination` fire that could not before.

4. `simplifyExpression` has no rule for `x AND NOT x` or `x OR NOT x`. Add one and work out, on paper first, what it must return when `x` is `NULL`. (The answer is not `false` and not `true`.)

5. Comment out the `factorCommonConjuncts` call and run `npm run test:e2e`. If nothing fails, that is a gap in the test suite — write the differential test that would have caught it.

## Recap

- `ExpressionSimplifier` runs **first** in the pipeline because its real product is more top-level **conjuncts**, which is the unit every later pass reasons about.
- It visits only `Filter` conditions, `Project` expressions, and `Join` conditions. Sort keys and group-by keys are **not simplified**.
- It folds constants, casts, and `EXTRACT`; collapses `CASE` branches with constant conditions; and applies one-sided arithmetic identities, guarding every fold against `NULL`.
- The boolean rules are stated so that they hold under **three-valued logic**, which is why `false AND x` is a rule and `x AND NOT x` is not.
- [`factorCommonConjuncts`](../../src/optimizer/passes/expression-simplifier.ts) applies the distributive law to lift shared conjuncts out of an `OR`. On a join query that is the difference between filtering both inputs and filtering neither.
- A condition that folds to `false` becomes an **`Empty`** node that still holds its child; deleting the dead subtree is a later pass's job.

Next: [chapter 17](17-predicate-pushdown.md) takes those conjuncts and decides how far down the tree each one can legally go.
