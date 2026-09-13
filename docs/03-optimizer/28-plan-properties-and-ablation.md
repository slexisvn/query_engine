# 28. Plan properties and the ablation invariant

> After this chapter you will be able to design a pass-ablation experiment and distinguish evidence from a test corpus from a proof of equivalence.

## The question

Remove predicate pushdown from the optimizer and compile the book's running query:

```javascript
const engine = createEngine();
registerTable(engine, 'CUSTOMER', customers);
registerTable(engine, 'ORDERS', orders);

engine.optimizer.removePass('PredicatePushdown');
engine.optimizer.listPasses().length;        // 22
```

Twenty-two, down from twenty-four. Both registrations are gone. Now compile:

```
-> Project (C.C_NAME, SUM(O.O_TOTALPRICE))
  -> Top-N (count: 10, order: SUM(O.O_TOTALPRICE) DESC)
    -> Aggregate (group by: C.C_NAME) (aggs: SUM(O.O_TOTALPRICE))
      -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
        -> Filter (condition: (C.C_MKTSEGMENT = 'BUILDING'))
          -> Seq Scan on CUSTOMER as C
        -> Seq Scan on ORDERS as O
```

The filter is below the join. Predicate pushdown ran. Ask again:

```javascript
engine.optimizer.listPasses().length;        // 24
```

The pass came back. Removing it did nothing, the plan is the fully optimized one, and no error was raised anywhere. Every ablation experiment written this way silently measures nothing.

## The invariant

Part 3 has described twenty-three passes. Every one of them is bound by a rule stated in [chapter 14](14-why-optimize.md) and never since revisited:

**Removing an optional optimization pass may change performance, but must preserve the query's specified result.**

A pass need not change performance on every query. Some transformations are required lowering steps rather than optional optimizations; this engine's subquery unnesting is one such exception.

This is a contract to test, not an automatic property of tree rewriting. Disabling a complete optional pass and deleting a guard inside a pass are different experiments. Deleting the null-rejection, uniqueness, or null-safe comparison checks from earlier chapters can make an enabled rewrite unsound.

Unit tests can catch unsound rewrites when they assert meaningful semantic cases. A test checking only that a filter moved is weaker. Comparing answers across pipelines adds coverage of interactions between passes and operators.

One pass is exempt, and the test names it:

```typescript
const CORRECTNESS_CRITICAL_PASS = 'SubqueryUnnesting';
```

Removing `SubqueryUnnesting` does not make correlated queries slower; it makes them fail, as [chapter 26](26-subquery-unnesting.md) showed. The exemption is checked in its own direction — a separate test asserts that *every* correlated query in the corpus errors once the pass is removed.

## Why the naive experiment does nothing

The opening result comes from four lines in [`_ensureStatistics`](../../src/engine/query-engine.ts):

```typescript
const generationBefore = this.statsCache.generation;
const collected = await this.collectStatistics(tables);
if (!collected || this.statsCache.generation === generationBefore) return;

this.optimizer = this.createOptimizer(collected);
```

The first query over a set of tables collects their statistics, which bumps the cache generation, which means the optimizer that was built without statistics is now out of date. So the engine **throws it away and builds a new one** from [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) — with all twenty-four registrations, because that is what the factory returns.

`removePass` mutated the *object*. The object was replaced. Nothing about the mutation was recorded anywhere the factory could see.

Note the shape of the guard: the rebuild happens only when the generation *changed*, which means it happens once per set of tables and not on subsequent queries. So the ablation survives from the second query onward — which is worse than failing outright, because an experiment that runs one query gets a different answer from one that runs two.

There are two ways to do it properly.

**Warm the statistics first.** Run any query over the tables, so the generation has already settled, and only then remove the pass:

```javascript
await engine.run("SELECT COUNT(*) FROM CUSTOMER");
await engine.run("SELECT COUNT(*) FROM ORDERS");
engine.optimizer.removePass('PredicatePushdown');
```

```
-> Project (C.C_NAME, SUM(O.O_TOTALPRICE))
  -> Top-N (count: 10, order: SUM(O.O_TOTALPRICE) DESC)
    -> Aggregate (group by: C.C_NAME) (aggs: SUM(O.O_TOTALPRICE))
      -> Filter (condition: (C.C_MKTSEGMENT = 'BUILDING'))
        -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
          -> Seq Scan on CUSTOMER as C
          -> Seq Scan on ORDERS as O
```

The filter is above the join. That is the ablated plan.

**Override the factory**, which is what the tests do:

```typescript
const base = engine.createOptimizer.bind(engine);
engine.createOptimizer = (statistics) => base(statistics).removePass(removedPass);
engine.optimizer = engine.createOptimizer(engine.precomputedStats);
```

Now every rebuild produces the trimmed pipeline, whatever the statistics do. This is the robust form, and `tests/e2e/join-reorder-differential.test.ts` has a test whose only job is to assert it holds:

```typescript
it('removes JoinReorder from the comparison engine even after statistics are collected', async () => {
  const plain = withoutJoinReorder();
  await plain.run(`SELECT COUNT(*) AS N FROM CUSTOMERS`);
  expect(plain.optimizer.listPasses()).not.toContain('JoinReorder');
});
```

A test for a trap in the test harness itself.

## The differential test

[`tests/e2e/subquery-unnesting-differential.test.ts`](../../tests/e2e/subquery-unnesting-differential.test.ts) is the invariant made executable. It holds a corpus of 51 queries — 37 correlated, 9 with a subquery conjoined to another predicate, 5 uncorrelated — over four small tables seeded with exactly the cases that break decorrelation: a null foreign key, a null aggregate input, an orphan row matching no customer, and a null in a column a mark join compares.

`runConfiguration` builds an engine with one pass removed, runs every query, and records either the sorted rows or the error message. Then:

```typescript
for (const pass of base.passes) {
  if (pass === CORRECTNESS_CRITICAL_PASS) continue;
  const trimmed = await runConfiguration(pass);
  for (const sql of CORPUS) {
    ...
    if (expected.rows!.join('') !== actual.rows!.join('')) {
      divergences.push(`without ${pass}: ${sql}\n  default: ...\n  trimmed: ...`);
    }
  }
}
expect(divergences).toEqual([]);
```

Twenty-three trimmed pipelines times fifty-one queries, compared against the full pipeline's answers. Any pass whose removal changes a single row fails the test and names the pass and the query.

Three companion tests cover the edges: every corpus query must answer without erroring under the default pipeline; the conjoined queries must not depend on `PredicatePushdown`; and removing `SubqueryUnnesting` must make every correlated query error rather than answer wrongly.

The other differential tests in `tests/e2e/` apply the same shape to other axes. `join-reorder-differential.test.ts` compares answers with and without `JoinReorder` over a generated corpus that exercises every join keyword; `merge-join-order-differential.test.ts` compares a merge-join plan against sorting above a hash join; `column-encoding-differential.test.ts` compares every storage encoding against the unencoded build. **Same technique, different thing held constant.**

## Estimates and guarantees are different properties

An annotation can influence correctness even when it changes no visible node. To see why, distinguish an estimate from a guarantee.

[`PlanProperties`](../../src/optimizer/passes/plan-properties.ts) adds no nodes, removes none, and rewrites no expressions. It annotates:

```typescript
return {
  ...rewritten,
  _cardinality: this.estimateCardinality(rewritten),
  _sortedBy: inferSortOrder(rewritten),
};
```

Run it on the running query's optimized plan and print both fields:

```
-> Project (C.C_NAME, SUM(O.O_TOTALPRICE))                        [rows=10,  sortedBy=[]]
  -> Top-N (count: 10, order: SUM(O.O_TOTALPRICE) DESC)           [rows=10,  sortedBy=[]]
    -> Aggregate (group by: C.C_NAME) (aggs: SUM(O.O_TOTALPRICE)) [rows=174, sortedBy=[]]
      -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))            [rows=174, sortedBy=[]]
        -> Filter (condition: (C.C_MKTSEGMENT = 'BUILDING'))      [rows=40,  sortedBy=[]]
          -> Seq Scan on CUSTOMER as C                            [rows=200, sortedBy=[]]
          -> Seq Scan on ORDERS as O                              [rows=1000, sortedBy=[]]
```

Against the real counts: the filter's 40 is exact, the join's 174 against an actual 200 is 13% low, and the aggregate's 174 against an actual 40 groups is 4.3 times high — [chapter 23](23-cardinality-estimation.md)'s square-root damping in `estimateAggregate` under-counting the collapse.

`_sortedBy` is empty everywhere, including on the `Top-N`. [`inferSortOrder`](../../src/planner/sort-properties.ts) maps a `TOP_N`'s order keys through `columnKeyOf` and discards anything that is not a column reference — and this plan's order key is `SUM(O.O_TOTALPRICE)`, an aggregate. The node really is sorted; the annotation cannot say so.

Now the key fact:

```javascript
planSignature(optimized) === planSignature(withProperties)   // true
formatPlan(optimized)    === formatPlan(withProperties)      // true
```

Both fields start with `_`, so [`planSignature`](../../src/optimizer/plan-signature.ts) skips them, as chapter 15 described. `formatPlan` also omits them. That makes them invisible to these two inspection tools, not necessarily to an answer comparison: an annotation can cause a later pass to delete work.

`_cardinality` is an estimate: underestimating a build input can lead to a poor algorithm or unexpected spilling. `_sortedBy` is a guarantee: claiming an unsorted input is sorted can make `SortElimination` remove a necessary sort. A missing ordering fact can cost performance; a false positive can change the answer.

For a hand-worked counterexample, consider rows `[3, 1, 2]` and `ORDER BY x LIMIT 1`. The answer must be `1`. If an incorrect ordering annotation licenses skipping the sort and taking the first input row, the result becomes `3`. A test that sorts the final outputs before comparing them can also miss order-only bugs on larger results. Ordered queries need ordered comparisons.

**Approximate planning needs exact legality checks.** Costs and cardinalities guide a choice among valid plans. Ordering, uniqueness, null behavior, and pruning decisions justify whether work can be removed at all. Those properties must be sound. Differential tests provide evidence on their corpus, and targeted tests should exercise missing, correct, and falsely claimed properties.

## In the code

| Idea | Where |
|---|---|
| Annotation pass | [`PlanProperties`](../../src/optimizer/passes/plan-properties.ts) |
| The annotator | [`PlanPropertyAnnotator`](../../src/planner/plan-properties.ts) |
| Ordering inference | [`inferSortOrder`](../../src/planner/sort-properties.ts) |
| Cardinality annotation | [`estimateNodeCardinality`](../../src/planner/cardinality.ts) |
| Why annotations are invisible | [`planSignature`](../../src/optimizer/plan-signature.ts) |
| Optimizer rebuild on stats | [`_ensureStatistics`](../../src/engine/query-engine.ts) |
| The factory it rebuilds from | [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) |
| Removing a pass | [`removePass`](../../src/optimizer/optimizer.ts) |
| The ablation test | [`tests/e2e/subquery-unnesting-differential.test.ts`](../../tests/e2e/subquery-unnesting-differential.test.ts) |
| Join-order differential | [`tests/e2e/join-reorder-differential.test.ts`](../../tests/e2e/join-reorder-differential.test.ts) |

## Traps

**`removePass` before the first query is undone by the first query.** And only by the first: the rebuild is guarded on the statistics generation having changed, so an experiment that runs two queries behaves differently from one that runs one.

**`removePass` removes every registration of a name.** `PredicatePushdown` appears twice; there is no way to drop only the second.

**`listPasses()` is the check that matters.** Print it after compiling, not after `removePass`. The opening example passes the second check and fails the first.

**Annotations can produce wrong answers through their consumers.** A false ordering claim can delete a required sort; an unsound pruning predicate can skip matching rows. Test these consequences, including result order when SQL specifies it. The physical planner may recompute properties, so removing one annotation pass alone need not exercise all of those cases.

**The corpus samples the specification.** Passing the queries in the file is evidence for those cases, not a proof for every SQL query. Add cases for new shapes, and keep some expected answers independent of the default pipeline: two variants can share the same bug.

## Recap

- The **ablation invariant**: removing any single pass may change speed and nothing else. One pass is exempt — `SubqueryUnnesting`, whose removal makes correlated queries fail, tested in its own direction.
- [`_ensureStatistics`](../../src/engine/query-engine.ts) rebuilds the optimizer from [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) the first time statistics are collected, which **silently undoes** a `removePass` performed beforehand. Warm the statistics first, or override `createOptimizer` as the tests do.
- The differential tests run a corpus across every trimmed pipeline and compare **answers**, not plans — 23 pipelines times 51 queries in the subquery test alone.
- [`PlanProperties`](../../src/optimizer/passes/plan-properties.ts) annotates `_cardinality` and `_sortedBy`. Both are omitted by `planSignature` and `formatPlan`, but their downstream effects can be visible in query answers.
- Cardinality and cost estimates may be approximate. Ordering, uniqueness, and pruning facts used to remove work must be sound; false positives can change results.

That closes Part 3. The query is now a plan the engine believes is a good one. Next: Part 4 opens with chapter 29, which turns that plan into operators and finds out whether the belief was justified.
