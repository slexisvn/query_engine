# 23. Cardinality estimation

> After this chapter you will be able to predict what the optimizer thinks a plan node will produce, find the places where it is badly wrong, and explain each one from the function that produced it.

## The question

Two ways to spell the same query, over a table of 200,000 rows whose `K` column holds 200,000 distinct values:

```sql
SELECT DISTINCT K FROM BIG
SELECT K FROM BIG GROUP BY K
```

Both return 200,000 rows. Ask the estimator what it expects:

```
SELECT DISTINCT K FROM BIG    ->  447
SELECT K FROM BIG GROUP BY K  ->  200000
```

The second is exactly right. The first is wrong by a factor of 447, and 447 is `round(sqrt(200000))`, which is not a coincidence. It is this line:

```typescript
function distinctRows(card: number): number {
  return Math.max(1, Math.round(Math.sqrt(card)));
}
```

The estimator has full statistics for `K` — it used them to get the `GROUP BY` answer exactly right — and does not consult them for `DISTINCT`. This chapter is about where the estimates come from, which of them are principled, and which are one-line guesses like this one.

## Two layers

Everything in this chapter lives in [`src/planner/cardinality.ts`](../../src/planner/cardinality.ts), and it splits cleanly in two.

**Selectivity** — the fraction of rows a predicate keeps, from [chapter 21](21-access-paths-and-orderings.md) — is computed from column statistics, and [`estimateSelectivity`](../../src/planner/cardinality.ts) is the entry point, dispatching on expression kind. This chapter is where every kind gets its rule.

**Cardinality** is the number of rows a plan node produces. [`estimateNodeCardinality`](../../src/planner/cardinality.ts) looks the node type up in `CARDINALITY_RULES` and calls a rule with the node and its inputs' cardinalities:

```typescript
export function estimateNodeCardinality(estimator, node, inputCardinalities): number {
  const rule = CARDINALITY_RULES[node.type];
  if (rule) return rule(estimator, node, inputCardinalities);
  return inputCardinalities.length > 0 ? inputCardinalities[0] : Config.defaultCardinality;
}
```

A node type with no rule passes its first input's cardinality through, and a node with no inputs at all defaults to `Config.defaultCardinality` = 1,000. Bottom-up composition of these two layers is the whole estimator.

## Equality: three tiers

[`estimateEqualitySelectivity`](../../src/planner/cardinality.ts) is the most-used path, and it tries three things in order.

**Is the literal a most-common value?** If so, use its recorded frequency directly:

```typescript
if (stats.mcv) {
  const mcvIdx = stats.mcv.values.indexOf(litStr);
  if (mcvIdx >= 0) return stats.mcv.frequencies[mcvIdx] * (1 - (stats.nullFraction || 0));
}
```

**Otherwise, spread the remaining rows over the remaining distinct values.** Subtract the MCVs' share of both the frequency mass and the distinct count, and divide:

```typescript
const residualNdv = ndv - (stats.mcv?.values.length ?? 0);
const residualFraction = nonNullFraction * (1.0 - (stats.mcv?.totalFrequency ?? 0));
if (residualNdv > 0 && residualFraction > 0) return residualFraction / residualNdv;
```

**Otherwise, `1/ndv`.** And with no statistics for the column at all, a flat `0.1`.

This is a good estimator when the MCV list is real. [Chapter 22](22-statistics.md) showed that on a high-cardinality column the list is *not* real — ten arbitrary values with inflated frequencies — and this function has no way to tell.

For `col = col` between two columns it returns `1 / max(leftNdv, rightNdv)`, the containment assumption: every value of the smaller domain is assumed to appear in the larger one.

## Ranges, and the histogram

[`estimateRangeSelectivity`](../../src/planner/cardinality.ts) prefers the histogram:

```typescript
const frac = stats.histogram.estimateLessThan(literal.value);
const sel = isLessThan ? frac : (1.0 - frac);
return Math.max(MIN_SELECTIVITY, sel * (1 - (stats.nullFraction || 0)));
```

`isLessThan` is computed from both the operator *and* which side the column is on, so `5 > x` and `x < 5` agree. Without a histogram it falls back to linear interpolation between `min` and `max`, and without statistics to a flat `0.33`.

`BETWEEN` goes to [`estimateBetweenSelectivity`](../../src/planner/cardinality.ts), which uses `estimateRange` — the difference of two `estimateLessThan` calls plus the equality mass at the top bound, so the upper endpoint is inclusive.

`LIKE` gets its own analysis in [`estimateLikeSelectivity`](../../src/planner/cardinality.ts), classifying the pattern as exact, prefix, contains, or suffix and scaling with `ndv` and `avgLength`. A prefix pattern with a prefix as long as the average value estimates `1/ndv`; a shorter prefix estimates a fractional power of `ndv`. Anything with a `%` in the middle falls to a constant 0.15.

## Conjunctions are not assumed independent

Most textbook estimators multiply: `sel(a AND b) = sel(a) * sel(b)`. This one blends:

```typescript
const independent = sl * sr;
const correlated = Math.min(sl, sr);
const correlation = this.lookupCorrelation(predicate.left, predicate.right);
const blended = independent * (1 - correlation) + correlated * correlation;
return Math.max(MIN_SELECTIVITY, Math.min(correlated, blended));
```

Two extremes: independence multiplies, perfect correlation takes the minimum (if every row satisfying `b` also satisfies `a`, the pair is as selective as `a` alone). The blend is linear in a correlation coefficient, and the result is clamped so it never exceeds the correlated bound.

[`lookupCorrelation`](../../src/planner/cardinality.ts) extracts one column from each side and asks the table's correlation map — but only when both columns come from the *same* alias. Anything else, including a missing correlation entry, returns `DEFAULT_CORRELATION` = 0.5.

That default is doing most of the work, because chapter 22 showed correlations are only stored above a threshold of 0.3. So in practice a two-conjunct filter is estimated halfway between independent and fully correlated:

```
WHERE K < 100000                       -> 100556   (actual 100000)
WHERE SEG = 'S3'                       ->  28571   (actual  28571)
WHERE K < 100000 AND SEG = 'S3'        ->  21468   (actual  14286)
```

The two single predicates are nearly exact. Their conjunction is 50% high, because the columns are in fact independent and the estimator hedged. That hedge is deliberate: under-estimating a join input is far more expensive than over-estimating one, since it leads to building a hash table that does not fit.

## Joins

`JOIN_CARDINALITY_RULES` maps each join type to a rule. The interesting one is [`estimateJoin`](../../src/planner/cardinality.ts) for inner joins:

```typescript
let selectivity = 1.0;
for (const pred of equiPreds) {
  selectivity *= this.estimateEquiJoinSelectivity(pred.left, pred.right, leftCard, rightCard);
}
for (const residual of this.residualConjuncts(condition)) {
  selectivity *= this.estimateSelectivity(residual);
}
return Math.max(1, Math.round(leftCard * rightCard * selectivity));
```

An **equi-join** conjunct is one of the form `left.col = right.col` — an equality between a column from each side. That shape is worth naming because it is the only one a hash table can answer: you can hash a value and look it up, but you cannot hash `<`. Almost every join anyone writes is an equi-join, and [chapter 29](../04-execution/29-logical-to-physical.md) shows how much the choice of algorithm depends on there being one.

Equi-join conjuncts are handled by their own estimator; anything else in the condition is treated as an ordinary filter on the product. No condition at all gives `leftCard * rightCard`, which is the correct answer for a cross join.

[`estimateEquiJoinSelectivity`](../../src/planner/cardinality.ts) is the most careful function in the file. With neither MCVs nor histograms it uses the textbook `1 / max(ndvA, ndvB)`. With them it splits both columns into a head and a tail:

- **Head:** the MCV values. Values present in both lists contribute `freqA * freqB` each — an exact join frequency for the values that matter most.
- **Tail:** everything else. Its collision rate comes from [`_histogramJoinCollision`](../../src/planner/cardinality.ts) if both columns have counted histograms, and otherwise from `1 / max(ndOtherA, ndOtherB)`.

[`histogramJoinCollision`](../../src/planner/cardinality.ts) is the piece that makes this better than a single ratio. It cuts the overlapping range at every bucket boundary from either histogram, and for each segment computes `(rowsA/totA) * (rowsB/totB) / max(distinctA, distinctB)`, summing the result. Two columns whose ranges barely overlap get a small number even when their `ndv`s are similar — which a single `1/max(ndv)` cannot express.

The outer variants build on the inner estimate. A left join is `max(leftCard, innerCard)` — every left row survives, plus fan-out. A full join is `max(left, right, inner)`. A semi join uses [`estimateSemiJoinSelectivity`](../../src/planner/cardinality.ts), which asks what fraction of the left side finds a partner, and an anti join is the left cardinality minus the semi estimate. `MARK` and `SINGLE` joins return `leftCard` exactly, which is their definition: one output row per left row.

## Aggregates, and the DISTINCT guess

[`estimateAggregate`](../../src/planner/cardinality.ts) predicts the number of groups. With one grouping column it is that column's `ndv`. With several, it does not multiply:

```typescript
const ndvs = groupByExprs.map(expr => this.getColumnNdv(expr)).sort((a, b) => b - a);
for (let i = 0; i < ndvs.length; i++) {
  if (i === 0) ndvProduct = ndvs[i];
  else ndvProduct *= Math.max(1, Math.sqrt(ndvs[i]));
}
return Math.max(1, Math.min(inputCard, Math.round(ndvProduct)));
```

The largest `ndv` counts fully; every additional column contributes only its square root. Multiplying would assume independence, which for grouping columns is usually wrong — `(city, country)` has far fewer combinations than `ndv(city) * ndv(country)`. Damping by a square root is a heuristic, not a derivation, but it errs toward under-counting groups rather than predicting more groups than there are rows. The final `min(inputCard, …)` enforces that bound.

And now the opening question. `DISTINCT` is a different plan node, with a different rule:

```typescript
[PlanNodeType.DISTINCT]: (_estimator, _node, inputs) => distinctRows(inputs[0]),
```

`sqrt(inputCard)`, ignoring statistics entirely. `SELECT DISTINCT K` and `SELECT K GROUP BY K` produce the same rows through different node types, and only one of the two rules looks at the data. On this table that is 447 versus 200,000.

The consequence is not academic. A `DISTINCT` under a join hands the join a cardinality that is the square root of the truth, which makes it look like the ideal build side — and it is a plausible way to arrive at a hash table four hundred times bigger than the plan expected. Note that [chapter 20](20-eliminating-work.md)'s `DistinctElimination` removes a `Distinct` over a primary key entirely, which sidesteps the worst case by deleting the node rather than by estimating it.

## The alias lookup

One more finding, because it changes every number in this chapter. [`getColumnStats`](../../src/planner/cardinality.ts) resolves a column reference to its statistics:

```typescript
const tableStats = this.stats.get(expr.tableAlias?.toUpperCase());
if (tableStats?.columnStats?.has(columnName)) return tableStats.columnStats.get(columnName) ?? null;

for (const stats of this.stats.values()) {
  if (stats.columnStats?.has(columnName)) return stats.columnStats.get(columnName) ?? null;
}
return null;
```

The statistics map is keyed by **table name**. The bound reference carries a **table alias**. When a query writes `FROM BETA y`, the alias is `Y`, `stats.get('Y')` misses, and the fallback loop returns the first table in the map with a column of that name — which need not be the right table.

Two tables, `ALPHA` with a unique `ID` and `BETA` whose `ID` has four distinct values:

```
SELECT ID FROM ALPHA WHERE ID = 7        ->    1     (actual 1)
SELECT ID FROM BETA WHERE ID = 2         ->  250     (actual 250)
SELECT x.ID FROM ALPHA x WHERE x.ID = 7  ->    1     (actual 1)
SELECT y.ID FROM BETA y WHERE y.ID = 2   ->    1     (actual 250)
```

The last two queries differ from the first two only by an alias. `y.ID` resolves to `ALPHA`'s statistics because `ALPHA` was registered first, and the estimate moves by a factor of 250.

Unaliased queries work because the planner uses the table name as the alias. Aliased queries over TPC-H-style schemas work because the column names are prefixed and unique across tables. Neither is a property the code checks.

## In the code

| Idea | Where |
|---|---|
| Node-level dispatch | [`estimateNodeCardinality`](../../src/planner/cardinality.ts), `CARDINALITY_RULES` |
| The estimator | [`DefaultCardinalityEstimator`](../../src/planner/cardinality.ts) |
| Predicate dispatch | [`estimateSelectivity`](../../src/planner/cardinality.ts) |
| Equality | [`estimateEqualitySelectivity`](../../src/planner/cardinality.ts) |
| Ranges | [`estimateRangeSelectivity`](../../src/planner/cardinality.ts) |
| Pattern matching | [`estimateLikeSelectivity`](../../src/planner/cardinality.ts) |
| Correlation blending | [`lookupCorrelation`](../../src/planner/cardinality.ts) |
| Inner joins | [`estimateJoin`](../../src/planner/cardinality.ts), [`estimateEquiJoinSelectivity`](../../src/planner/cardinality.ts) |
| Histogram-aware join | [`histogramJoinCollision`](../../src/planner/cardinality.ts) |
| Semi and anti joins | [`estimateSemiJoin`](../../src/planner/cardinality.ts), [`estimateAntiJoin`](../../src/planner/cardinality.ts) |
| Grouping | [`estimateAggregate`](../../src/planner/cardinality.ts) |
| Statistics lookup | [`getColumnStats`](../../src/planner/cardinality.ts) |

## Traps

**`DISTINCT` is estimated as `sqrt(input)`**, with no reference to statistics, while the identical `GROUP BY` uses `ndv`.

**Column statistics are found by alias first, then by a scan of every table for a matching column name.** With aliases and shared column names, an estimate can come from the wrong table entirely.

**Conjunctions default to 50% correlated.** A filter with several independent predicates is systematically over-estimated. This is a deliberate bias toward over-estimation, not a bug, but it is worth knowing before you trust an `est` value in `EXPLAIN ANALYZE`.

**Every selectivity is floored at `MIN_SELECTIVITY` = 0.0001**, and every filter cardinality at 1 row. A genuinely empty result is estimated as one row, which is what keeps downstream arithmetic from collapsing to zero.

**`estimateExistsSelectivity` plans the subquery to estimate it**, calling `createLogicalPlan` on the bound query and estimating the result. The answer is memoized in a `WeakMap`, but a query with many distinct subqueries pays for planning each one during estimation.

**A node type with no rule passes its child's cardinality through unchanged.** `Window` and `Materialize` do this, which is right, and so does anything added later without a rule, which may not be.

## Exercises

1. Reproduce the `DISTINCT` versus `GROUP BY` gap, then extend `CARDINALITY_RULES` so `DISTINCT` uses the same `estimateAggregate` path as an aggregate over its child's output columns. Which tests change?

2. Reproduce the alias table. Then register the two tables in the opposite order and confirm the estimate changes without the query changing.

3. Fix the alias lookup. The plan node has the alias and the scan beneath it has the table name; work out where an alias-to-table map would have to be built and threaded, and how much of the estimator's interface it changes.

4. Set `QE_STATS_CORRELATION_THRESHOLD` to 0 so every correlation is stored, then re-estimate a two-predicate filter over genuinely independent columns. Did the estimate improve? Explain from `lookupCorrelation`.

5. Build two tables whose join keys have similar `ndv` but barely overlapping ranges. Compare `estimateEquiJoinSelectivity` with and without histograms by constructing statistics objects with the histogram removed.

## Recap

- Estimation has two layers: **selectivity** for predicates and **cardinality** for nodes, composed bottom-up.
- Equality selectivity checks the **MCV list**, then spreads the residual mass over the residual distinct values, then falls back to `1/ndv`.
- Ranges use the **histogram** when there is one, linear interpolation between `min` and `max` when there is not, and 0.33 when there are no statistics.
- Conjunctions are a **blend of independent and fully correlated**, weighted by a stored correlation or a default of 0.5 — a deliberate bias toward over-estimation.
- Equi-joins split the columns into an **MCV head** and a **histogram tail**, which lets a join between non-overlapping ranges be estimated as small.
- Grouping uses the largest `ndv` fully and **damps each additional key by its square root**.
- Two mechanisms produce large errors regardless of statistics quality: `DISTINCT` is `sqrt(input)`, and statistics are looked up by **alias with a name-matching fallback** that can return another table's numbers.

Next: [chapter 24](24-the-cost-model.md) turns row counts into a number of arbitrary units, and shows the same query choosing three different join algorithms as its tables grow.
