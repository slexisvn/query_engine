# 27. Dependent joins and decorrelation

> After this chapter you will be able to explain why changing one operator in a correlated subquery makes the plan grow a `Distinct` over the outer table, and say what that extra relation is for.

## The question

Two correlated scalar subqueries. They differ by a single character:

```sql
SELECT c.C_NAME, (SELECT COUNT(*) FROM ORDERS o WHERE o.O_CUSTKEY = c.C_CUSTKEY) AS N FROM CUSTOMER c
SELECT c.C_NAME, (SELECT COUNT(*) FROM ORDERS o WHERE o.O_TOTALPRICE > c.C_CUSTKEY) AS N FROM CUSTOMER c
```

The first decorrelates into three nodes:

```
-> Project (C.C_NAME, COALESCE(_scalar_0, 0))
  -> LEFT Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
    -> Seq Scan on CUSTOMER as C
    -> Project (COUNT_STAR(), O.O_CUSTKEY)
      -> Aggregate (group by: O.O_CUSTKEY) (aggs: COUNT_STAR())
        -> Seq Scan on ORDERS as O
```

The second grows a whole second copy of `CUSTOMER`:

```
-> Project (C.C_NAME, COALESCE(_scalar_1, 0))
  -> LEFT Join (condition: (C.C_CUSTKEY = __domain_0.c0))
    -> Seq Scan on CUSTOMER as C
    -> Project (COUNT_STAR(), __domain_0.c0)
      -> Aggregate (group by: __domain_0.c0) (aggs: COUNT_STAR())
        -> Filter (condition: (O.O_TOTALPRICE > __domain_0.c0))
          -> CROSS Join
            -> Seq Scan on ORDERS as O
            -> Distinct
              -> Project (C.C_CUSTKEY)
                -> Seq Scan on CUSTOMER as C
```

An `=` became a `>` and the plan acquired a cross join against every distinct value of the correlating column. That relation has a name — the **domain** — and choosing whether to build it is the central decision in decorrelation.

## What has to happen

[Chapter 26](26-subquery-unnesting.md) picked the join type. What it did not explain is how `C.C_CUSTKEY` stopped appearing inside the subquery's plan.

A correlated subquery is a function of the outer row. Executing it literally means running the subquery once per outer row — the "dependent join" of its name, and *O(n)* subquery executions. Decorrelation turns it into a function of a *relation*: run the subquery once over all the correlating values at once, then join the results back.

Two things must be true for that to work. Every correlating reference inside the subquery must be replaced by something the subquery's own inputs provide, and the subquery's output must carry enough columns to match rows back to the right outer row.

## Finding the correlation

[`CorrelationSet`](../../src/optimizer/dependent-join/correlation.ts) holds the correlating columns, deduplicated by `ALIAS.COLUMN` key. Its `matches` is deliberately generous:

```typescript
matches(ref: BoundColumnRefNode): boolean {
  return ref.isCorrelated || this.keys.has(correlationKeyOf(ref));
}
```

Either the binder marked the reference correlated — the `depth > 0` result from [chapter 8](../01-frontend/08-binder-scopes-and-names.md) — or its key is one the dependent join recorded. Both, because rewriting can strip the flag while the key remains recognizable.

[`collectCorrelatedNodes`](../../src/optimizer/dependent-join/correlation.ts) marks every plan node that is correlated, directly or through a descendant:

```typescript
const visit = (node: LogicalPlanNode): boolean => {
  let dependent = referencesCorrelationLocally(node, set);
  for (const child of getChildren(node)) {
    if (visit(child)) dependent = true;
  }
  if (dependent) correlated.add(node);
  return dependent;
};
```

The result is a set that forms a connected region from the root of the subquery down to wherever the correlation actually lives. Everything outside it is independent of the outer row and can be left alone — which is what makes the pushdown below stop early rather than rewriting the whole subquery.

`referencesCorrelationLocally` reads a node's own expressions through [`ownExpressions`](../../src/optimizer/dependent-join/correlation.ts), a per-node-type table covering filter and join conditions, projections, grouping keys, aggregate arguments, sort keys, window expressions, exchange partition keys, and a scan's `pruningFilter`. A node type missing from that table looks uncorrelated whatever it contains.

## Two domains

The correlation has to be replaced by something. [`chooseDomain`](../../src/optimizer/dependent-join/domain-choice.ts) picks between two strategies:

```typescript
return canLiftCorrelation(subquery, set, correlated)
  ? new LiftedDomain(set, distinguishesUnknown)
  : new MaterializedDomain(set, outer);
```

### The lifted domain

[`LiftedDomain`](../../src/optimizer/dependent-join/domain.ts) does not build a relation at all. Its width is zero and its `anchor` returns the plan unchanged. What it does is *remove* the correlated predicate from inside the subquery and hand it to the caller to become a join condition:

```typescript
correlatedConjunct(pred: BoundExpr): CorrelatedConjunct {
  const lifted = decorrelateRefs(pred, this.set);
  return {
    lift: this.distinguishesUnknown ? definitelyTrue(lifted) : lifted,
    keep: null,
    column: equiBindingColumn(pred, this.set),
  };
}
```

`lift` is the predicate with the correlated flags cleared; `keep` is null, so nothing stays behind. `column` is the interesting field: [`equiBindingColumn`](../../src/optimizer/dependent-join/domain.ts) returns the *inner* column of an equality that has correlation on exactly one side:

```typescript
if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') return null;
const leftCorrelated = referencesCorrelation(pred.left, set);
const rightCorrelated = referencesCorrelation(pred.right, set);
if (leftCorrelated === rightCorrelated) return null;
const inner = leftCorrelated ? pred.right : pred.left;
return inner.kind === BoundExprKind.COLUMN_REF ? inner : null;
```

For `o.O_CUSTKEY = c.C_CUSTKEY` that is `O.O_CUSTKEY`. It becomes the subquery's grouping key, which is exactly what appears in the first plan: `Aggregate (group by: O.O_CUSTKEY)`. The correlating value has been replaced by a column the subquery already had.

### When lifting is not possible

[`canLiftCorrelation`](../../src/optimizer/dependent-join/domain-choice.ts) walks the correlated region checking two things per node.

**The correlation must be in a liftable predicate.** [`expressionsAreLiftable`](../../src/optimizer/dependent-join/domain-choice.ts) requires every correlated expression to *be* the node's liftable predicate — a `Filter` condition, or an inner or cross join condition:

```typescript
const predicate = liftablePredicate(node);
for (const expr of ownExpressions(node)) {
  if (!referencesCorrelation(expr, set)) continue;
  if (expr !== predicate) return false;
  const correlatedConjuncts = splitConjuncts(expr).filter((pred) => referencesCorrelation(pred, set));
  if (underConsumer && correlatedConjuncts.some((pred) => equiBindingColumn(pred, set) === null)) return false;
}
```

A correlated projection, a correlated grouping key, or a correlated `LEFT` join condition all fail immediately.

**Under a domain consumer, the correlation must be an equality.** `underConsumer` is set once the walk has passed through a node whose [`domainRoleOf`](../../src/optimizer/dependent-join/pushdown.ts) is `CONSUMES` — an aggregate, a window, a `DISTINCT`, or a row limit. Those operators need something to *group by*, and only an equality yields a binding column. That is the opening question's answer: `o.O_TOTALPRICE > c.C_CUSTKEY` has no `equiBindingColumn`, so under the `COUNT(*)` it cannot be lifted.

`branchesAreLiftable` adds a third condition for joins and set operations: at most one side may be correlated, and it must be a side listed in `DOMAIN_CARRYING_SIDES` for that join type. A `FULL` join carries neither side and disqualifies the whole subtree.

### The materialized domain

[`MaterializedDomain`](../../src/optimizer/dependent-join/domain.ts) builds the relation instead. Its `anchor` constructs a fresh alias and a distinct projection of the outer plan:

```typescript
const alias = `__domain_${domainInstanceCount++}`;
const projections: ProjectedExpr[] = this.set.columns.map((column, index) => ({
  ...decorrelateRefs(column, this.set),
  outputName: this.names[index],
}));
const relation = LogicalDistinct(LogicalProject(projections, this.outer, alias));
return { plan: LogicalJoin(JoinType.CROSS, null, node, relation), columns };
```

Read it against the opening plan. `Distinct → Project (C.C_CUSTKEY) → Seq Scan on CUSTOMER` is the domain: every distinct value the correlating column takes. `CROSS Join` pairs it with the subquery's input. The columns are renamed `c0`, `c1`, and so on under the generated alias, and `substitute` swaps every correlated reference for the matching domain column — which is why the filter reads `O.O_TOTALPRICE > __domain_0.c0` and the aggregate groups by `__domain_0.c0`.

The `Distinct` matters. Without it the cross join would multiply the subquery's input by the number of *outer rows*; with it, by the number of distinct correlating *values*. On a correlation over a low-cardinality column that is a large difference, and on a correlation over a primary key it is none at all.

`joinBack` then produces the equalities that reattach the result to the outer rows.

## Pushing the join down

[`pushDependentJoin`](../../src/optimizer/dependent-join/pushdown.ts) walks the subquery with the chosen domain. Its central method is one branch:

```typescript
push(node: LogicalPlanNode): PushResult {
  if (!this.correlated.has(node)) {
    const anchor = this.domain.anchor(node);
    return { plan: anchor.plan, domain: anchor.columns, carried: anchor.columns, ... };
  }
  const rule = PUSH_RULES[node.type];
  if (!rule) throw new Error(`Unsupported correlated subquery: a ${node.type} operator cannot carry a dependent join`);
  return rule(this, node);
}
```

**Stop at the first uncorrelated node and anchor there.** That is where the domain relation gets attached, as deep in the subquery as possible. Above it, each node type has a rule that rewrites it and reports three things upward: the `domain` columns, the `carried` columns that must be projected through, and any expression `substitutions`.

The rules are short and each says one thing:

- [`pushFilter`](../../src/optimizer/dependent-join/pushdown.ts) splits conjuncts and routes each through the domain's `correlatedConjunct` — lifted out, kept and substituted, or left alone if uncorrelated.
- [`pushAggregate`](../../src/optimizer/dependent-join/pushdown.ts) appends the domain columns to `groupBy`. That single line is what turns "one aggregate per outer row" into "one grouped aggregate".
- [`pushProject`](../../src/optimizer/dependent-join/pushdown.ts) adds any carried column not already projected, renaming it to `__carry_N` on a name collision, and records the translation so the columns keep their identity across the projection.
- [`pushJoin`](../../src/optimizer/dependent-join/pushdown.ts) pushes into the one correlated side when there is one. When both sides are correlated, it pushes into both and adds [`nullSafeEquals`](../../src/optimizer/dependent-join/domain.ts) conditions aligning the two copies of the domain.
- [`pushWindow`](../../src/optimizer/dependent-join/pushdown.ts) appends the domain to `partitionBy`, the window analogue of grouping.

`requireDomain` guards the consuming rules, throwing when a domain-consuming operator has no domain columns to group by.

## Turning a limit into a window

The most striking rule is [`pushRowLimit`](../../src/optimizer/dependent-join/pushdown.ts). "The most expensive order per customer" is `LIMIT 1` inside a correlated subquery, and a limit does not survive being merged across outer rows — one row total is not one row per customer. So the limit is replaced by a ranking:

```typescript
const rowNumber = BoundWindow(ROW_NUMBER, [], [...child.domain],
  orderKeys.map((key) => ({ expr: ctx.rewrite(key.expr, child), ... })), null, DataType.INT64);
const gate = rowNumberRange(rowNumber, limit.count, limit.offset);
const ranked = LogicalFilter(gate, LogicalWindow([rowNumber], transparent.inner));
```

`ROW_NUMBER() OVER (PARTITION BY <domain> ORDER BY <the subquery's order>)`, filtered to the requested range. `OFFSET` becomes the lower bound of that range. Real output:

```
(SELECT o.O_TOTALPRICE FROM ORDERS o WHERE o.O_CUSTKEY = c.C_CUSTKEY ORDER BY o.O_TOTALPRICE DESC LIMIT 1)

-> SINGLE Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
  -> Seq Scan on CUSTOMER as C
  -> Project (O.O_TOTALPRICE, O.O_CUSTKEY)
    -> Filter (condition: (<BoundWindow> <= 1))
      -> Window (ROW_NUMBER)
        -> Sort (O.O_TOTALPRICE DESC)
          -> Seq Scan on ORDERS as O
```

One sort and one window pass over `ORDERS`, instead of one sort per customer. The `<BoundWindow>` is [chapter 13](../02-logical-plan/13-reading-explain.md)'s unprintable expression kind, not a defect in the rewrite.

## Null-safe join-back

The final step decides how the domain is matched back to the outer rows. [`pushDependentJoin`](../../src/optimizer/dependent-join/pushdown.ts) ends with:

```typescript
const nullSafe = Array.from({ length: domain.width }, (_, index) =>
  alwaysNullSafe || !rejectsNullDomain(pushed.plan, domain.columnMatcher(index)));
```

A plain `=` never matches `NULL` to `NULL`. If the correlating column can be null and the subquery does not itself discard null domain rows, the join-back must use [`nullSafeEquals`](../../src/optimizer/dependent-join/domain.ts) — "both present and equal, or both absent" — or those outer rows silently vanish.

[`rejectsNullDomain`](../../src/optimizer/dependent-join/pushdown.ts) answers whether the rewritten subquery would have thrown the null domain rows away anyway, through a per-node-type table that mirrors the pass-through rules elsewhere in the optimizer: a filter rejects if its condition is null-rejecting or its child rejects; a `LEFT` join rejects only through its left child; a `UNION` rejects only if both sides do; an aggregate rejects only when it has grouping keys. When it does reject, the cheaper `=` is safe. `alwaysNullSafe` is [chapter 26](26-subquery-unnesting.md)'s `distinguishesUnknown`, true for mark joins, which forces the null-safe form regardless.

## In the code

| Idea | Where |
|---|---|
| Which references correlate | [`CorrelationSet`](../../src/optimizer/dependent-join/correlation.ts) |
| Which nodes are correlated | [`collectCorrelatedNodes`](../../src/optimizer/dependent-join/correlation.ts) |
| Per-node expression table | [`ownExpressions`](../../src/optimizer/dependent-join/correlation.ts) |
| Strategy choice | [`chooseDomain`](../../src/optimizer/dependent-join/domain-choice.ts), [`canLiftCorrelation`](../../src/optimizer/dependent-join/domain-choice.ts) |
| Lifting a predicate | [`LiftedDomain`](../../src/optimizer/dependent-join/domain.ts), [`equiBindingColumn`](../../src/optimizer/dependent-join/domain.ts) |
| Building a domain relation | [`MaterializedDomain`](../../src/optimizer/dependent-join/domain.ts) |
| The walk | [`pushDependentJoin`](../../src/optimizer/dependent-join/pushdown.ts), [`PushdownContext`](../../src/optimizer/dependent-join/pushdown.ts) |
| Per-node rules | `PUSH_RULES` in [`src/optimizer/dependent-join/pushdown.ts`](../../src/optimizer/dependent-join/pushdown.ts) |
| Limit as ranking | [`pushRowLimit`](../../src/optimizer/dependent-join/pushdown.ts) |
| Null-safe matching | [`nullSafeEquals`](../../src/optimizer/dependent-join/domain.ts), [`rejectsNullDomain`](../../src/optimizer/dependent-join/pushdown.ts) |

## Traps

**The domain is the outer plan, re-scanned.** `MaterializedDomain.anchor` references `this.outer` — the same subtree that is the join's left input — so the outer relation appears twice in the plan and is read twice. Every pass downstream sees two independent scans.

**`__domain_N` counters are module-global.** `domainInstanceCount` is a module-level variable, so alias numbering depends on how many correlated subqueries the process has already compiled. Two runs of the same query in different orders produce different alias digits; anything comparing plan text across runs must account for it.

**Lifting is decided for the whole subquery, not per predicate.** One non-liftable correlated conjunct anywhere in the correlated region sends the entire subquery to the materialized path.

**`ownExpressions` is a table.** A plan node type absent from `NODE_EXPRESSIONS` reports no expressions, so correlation inside it is invisible and the node looks safe to skip. Adding a node type that can hold expressions means adding an entry.

**The errors are the specification.** `PUSH_RULES` covers twelve node types; anything else throws `Unsupported correlated subquery: a <type> operator cannot carry a dependent join`. Reading the messages in [`pushdown.ts`](../../src/optimizer/dependent-join/pushdown.ts) is the fastest way to learn which correlated shapes this engine supports.

## Exercises

1. Reproduce the two opening plans. Then change `>` back to `=` but move the correlation into the `SELECT` list of the subquery instead of its `WHERE`, and predict which domain is chosen before running it.

2. Write a correlated subquery that returns the two most expensive orders per customer with `LIMIT 2` and confirm the `ROW_NUMBER` gate. Then add `OFFSET 1` and read the gate again.

3. Make the correlating column nullable and find a query where the plan uses `nullSafeEquals` and one where it does not. Explain the difference from `rejectsNullDomain`.

4. Add `SET_OP` handling that allows both sides to be correlated in `branchesAreLiftable`, then find out from `pushSetOp` why it is currently refused.

5. Instrument `chooseDomain` to log which domain it picked, then run the whole corpus in `tests/e2e/subquery-unnesting-differential.test.ts`. What fraction of correlated queries need the materialized path?

## Recap

- A correlated subquery is a function of the outer row. **Decorrelation** makes it a function of a relation, so it runs once instead of once per row.
- [`collectCorrelatedNodes`](../../src/optimizer/dependent-join/correlation.ts) marks the connected region of the subquery that depends on the outer row; the pushdown walk stops at its boundary and anchors there.
- The **lifted domain** removes the correlated predicate entirely, turning it into a join condition and using the equality's inner column as a grouping key. It needs every correlated predicate to sit in a filter or an inner-join condition, and to be an equality if it lies under an aggregate, window, `DISTINCT`, or limit.
- The **materialized domain** is the fallback: a `Distinct` projection of the correlating columns from the outer plan, cross-joined into the subquery, with every correlated reference substituted for a domain column.
- Consuming operators absorb the domain into their grouping: an aggregate adds it to `GROUP BY`, a window to `PARTITION BY`, and a **limit becomes a `ROW_NUMBER` window with a range filter**.
- The join-back uses a plain `=` only when the rewritten subquery provably discards null domain rows; otherwise it uses a **null-safe** comparison. Mark joins always use the null-safe form.

Next: [chapter 28](28-plan-properties-and-ablation.md) closes Part 3 with the invariant every one of these fifteen chapters has been quietly obeying, and the reason a naive attempt to test it does nothing at all.
