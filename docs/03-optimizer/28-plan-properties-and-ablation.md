# 28. Plan properties and the ablation invariant

> After this chapter you will be able to run the experiment that validates every pass in Part 3 — and avoid the version of it that silently tests nothing.

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

**Removing any single pass from the pipeline must change how fast a query runs, and nothing else.**

That is a strong claim, and it is the thing worth testing. It is also mostly false about optimizers in general — a pass that produces a wrong plan produces a plan that still runs, still returns rows, and usually returns *almost* the right ones. Chapter 17's `isNullRejecting` check, chapter 20's primary-key test, chapter 25's null-rejected middle, chapter 27's null-safe join-back: remove any of them and queries keep answering, differently.

Unit tests do not catch this. A test asserting that `PredicatePushdown` moves a filter below a join asserts that the pass does what it does. What is needed is a test that compares *answers* across pipelines.

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

## The pass that has nothing to ablate

There is one pass in the pipeline that this test can never catch, and it is worth ending on.

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

Both fields start with `_`, so [`planSignature`](../../src/optimizer/plan-signature.ts) skips them, exactly as [chapter 15](15-passes-and-fixpoints.md) described. And `formatPlan` never printed them. The pass is invisible to plan identity, invisible to the printer, and — because its output only affects *choices* made by `SortElimination` and the physical planner, never the rows — invisible to the differential test.

That is not a gap. It is what "changes speed and nothing else" looks like when a pass is doing its job perfectly: the annotation is a *hint*, and every consumer of it must remain correct when the hint is wrong. The physical planner asks whether an input is already sorted and adds a sort when the answer is no; `SortElimination` deletes a sort only when the annotation says the order is already there. A stale or missing `_sortedBy` costs a redundant sort. A stale `_cardinality` costs a worse join algorithm. Neither costs a row.

**The invariant is what lets the rest of the optimizer be approximate.** Cardinality estimates can be off by 4.3 times, the cost model's units can be arbitrary, the join-order search can give up at fourteen relations — and none of it can produce a wrong answer, because the passes that *would* change an answer are the ones held to an exact standard and tested against it.

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

**A pass that only annotates cannot fail the differential test.** `PlanProperties` and `ScanPruning` are both invisible to it. Their correctness is enforced by their consumers being written to tolerate a wrong hint, which is a design constraint, not a tested property.

**The corpus is the specification.** The invariant holds for the 51 queries in the file. A correlated shape nobody wrote a query for is not covered — adding a shape to the corpus is how you extend the guarantee.

## Exercises

1. Reproduce the opening. Run `removePass` before any query and print `listPasses().length` before and after compiling. Then warm the statistics first and confirm the ablated plan appears.

2. Take one pass you have modified while reading Part 3, break it deliberately in a way that changes an answer, and run `npm run test:e2e`. Does the differential test name your pass? Is the failure message enough to find the bug?

3. Add a query to `CORPUS` that the current corpus does not cover — a correlated subquery inside a `HAVING` clause, say — and confirm the test still passes. Then break `PredicateInference` and see whether your query catches it.

4. Write a differential test for a pass with no coverage today: build two engines, one with and one without `SortElimination`, run a corpus of `ORDER BY` queries, and compare rows *in order* rather than sorted.

5. Delete the `_` prefix from `_sortedBy` throughout, rebuild, and run the whole suite. Which fixpoint stage now runs to its cap, and what does that do to optimization time?

## Recap

- The **ablation invariant**: removing any single pass may change speed and nothing else. One pass is exempt — `SubqueryUnnesting`, whose removal makes correlated queries fail, tested in its own direction.
- [`_ensureStatistics`](../../src/engine/query-engine.ts) rebuilds the optimizer from [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) the first time statistics are collected, which **silently undoes** a `removePass` performed beforehand. Warm the statistics first, or override `createOptimizer` as the tests do.
- The differential tests run a corpus across every trimmed pipeline and compare **answers**, not plans — 23 pipelines times 51 queries in the subquery test alone.
- [`PlanProperties`](../../src/optimizer/passes/plan-properties.ts) annotates `_cardinality` and `_sortedBy` on every node. Both are invisible to `planSignature`, to `formatPlan`, and to the differential test, because they change **choices** and not rows.
- That separation is what buys the rest of Part 3 its freedom: estimates can be wrong by a factor of four, costs can be unitless, and the search can give up — none of it can produce a wrong answer.

That closes Part 3. The query is now a plan the engine believes is a good one. Next: Part 4 opens with chapter 29, which turns that plan into operators and finds out whether the belief was justified.
