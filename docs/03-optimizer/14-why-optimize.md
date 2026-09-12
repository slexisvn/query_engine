# 14. Why optimize at all

> After this chapter you will be able to measure the difference the optimizer makes on a query of your own, and say precisely which part of the plan the difference lives in.

## The question

Here is a query over three small tables — 200 customers, 1,000 orders, 25 nations:

```sql
SELECT c.C_NAME, o.O_ORDERKEY
FROM CUSTOMER c, ORDERS o, NATION n
WHERE c.C_CUSTKEY = o.O_CUSTKEY
  AND c.C_NATIONKEY = n.N_NATIONKEY
  AND c.C_NAME = 'Customer#17'
```

It returns five rows. Run the plan the logical planner produces and it takes **14,841.9 ms**. Run the plan the optimizer produces and it takes **1.4 ms**. Same engine, same data, same five rows, and a factor of about ten thousand between them.

Nothing about the query is pathological. It is three tables and three equality predicates, the shape of a hundred reports in any warehouse. The gap is not the cost of a clever trick — it is the cost of *not* doing something obvious, ten thousand times over.

## What the planner hands over

The logical planner is a transcription service. It walks the bound query and emits one node per clause, in the order the clauses were written. [Chapter 12](../02-logical-plan/12-building-the-plan.md) built it; here is what it produces for the query above:

```
-> Project (C.C_NAME, O.O_ORDERKEY)
  -> Filter (condition: (((C.C_CUSTKEY = O.O_CUSTKEY) AND (C.C_NATIONKEY = N.N_NATIONKEY)) AND (C.C_NAME = 'Customer#17')))
    -> CROSS Join
      -> CROSS Join
        -> Seq Scan on CUSTOMER as C
        -> Seq Scan on ORDERS as O
      -> Seq Scan on NATION as N
```

Read it literally, because the engine will. `FROM a, b, c` is a comma-separated list of relations with no join conditions attached, so it becomes two `CROSS Join` nodes: every customer paired with every order, then every one of those pairs paired with every nation. The `WHERE` clause is a single `Filter` sitting on top of the result.

That is a faithful translation of what you wrote. It is also a machine for building 200 × 1,000 × 25 = **5,000,000 intermediate rows** in order to keep five of them.

Now the optimized plan:

```
-> Project (C.C_NAME, O.O_ORDERKEY)
  -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
    -> Join (condition: (C.C_NATIONKEY = N.N_NATIONKEY))
      -> Filter (condition: (C.C_NAME = 'Customer#17'))
        -> Seq Scan on CUSTOMER as C
      -> Seq Scan on NATION as N
    -> Seq Scan on ORDERS as O
```

Three things happened, and each is a chapter of its own:

1. The `C_NAME` predicate moved down to sit directly on the `CUSTOMER` scan, so the rest of the plan sees one customer instead of two hundred. That is [predicate pushdown](17-predicate-pushdown.md).
2. The two equality predicates stopped being filters and became join conditions, which turned both `CROSS Join` nodes into inner joins. Also predicate pushdown — a predicate that mentions both sides of a join is folded into the join rather than left above it.
3. The join order changed. `CUSTOMER` joined to `NATION` now happens first, and its result joins `ORDERS`. That is [join ordering](25-join-ordering.md), and it is the only one of the three that required knowing how big the tables are.

The largest intermediate result in the optimized plan is one row. The largest in the unoptimized plan is five million.

## The optimizer is a function from plans to plans

There is no separate optimizer program, no intermediate representation, no code generation. [`optimize`](../../src/optimizer/optimizer.ts) takes a `LogicalPlanNode` and returns a `LogicalPlanNode` of the same type. Everything in Part 3 is an implementation of that signature.

That has a consequence worth stating early: **you can run any prefix of the optimizer you like, or none of it.** The engine's normal path calls [`compileUncached`](../../src/engine/query-engine.ts), which parses, binds, plans, collects statistics, and then optimizes. But nothing stops you from executing the raw plan directly, which is exactly how the two numbers at the top of this chapter were produced:

```javascript
const bound = engine.bind(engine.parseSQL(sql));
const rawPlan = engine.plan(bound);
const optimized = engine.optimize(rawPlan);

await engine._collectRows(rawPlan, bound.outputColumns, new Map());     // 14,841.9 ms
await engine._collectRows(optimized, bound.outputColumns, new Map());   //      1.4 ms
```

[`_collectRows`](../../src/engine/query-engine.ts) hands a plan straight to the executor with no optimization in between. Keep it — being able to run the unoptimized plan is what makes claims about the optimizer checkable rather than folkloric, and several exercises in this part depend on it.

## Three kinds of decision

Ask the engine what it is made of and you get twenty-four entries:

```javascript
engine.optimizer.listPasses().length          // 24
new Set(engine.optimizer.listPasses()).size   // 23
```

Twenty-four registrations, twenty-three distinct passes — `PredicatePushdown` appears twice. They are not twenty-three variations on one idea. They divide into three kinds, and the division shapes the rest of Part 3.

**Rewrites that are always an improvement.** Pushing a filter below a join, folding `2 + 3 * 4` into `14`, deleting a `Sort` whose output nobody looks at. These need no knowledge of the data. They are correct and beneficial for every table of every size, so the pass applies them unconditionally and no cost model is consulted. Chapters 16 through 19 are these, and so is most of what chapters 20 and 21 cover — each of those two also has a pass that stops to consult a statistic, and says so where it happens.

**Rewrites that need to know the data.** Which of two tables should build the hash table; whether `CUSTOMER` should meet `NATION` or `ORDERS` first; whether an index scan beats a sequential scan. The right answer flips depending on table sizes and value distributions, so the engine has to estimate them. Chapters 22 through 25 build that machinery: statistics, cardinality estimation, a cost model, and a search over join orders.

**Rewrites that change the shape of the query language.** A correlated subquery is not a join, and the operator the planner builds for one refuses to run. Chapters 26 and 27 turn subqueries into joins so that everything above can apply to them.

The third kind is the one to notice, because it explains why the optimizer is not optional. Predicate pushdown makes a query faster. Subquery unnesting makes some queries *possible* — run a correlated `EXISTS` plan without it and execution stops with `Correlated EXISTS subquery reached execution without being decorrelated; SubqueryUnnesting is required for correctness`.

## What the optimizer may not do

Every one of the twenty-four passes is bound by one rule: **the answer must not change.** Not "should not usually" — must not, for every input, including empty tables, duplicate rows, and nulls.

This is stricter than it sounds, and most of the difficulty in Part 3 comes from it. Chapter 17 shows a predicate that can safely move below a `LEFT JOIN` and one that cannot, and the difference is a three-line function. Chapter 20 shows a join that can be deleted outright, and the deletion is legal only because a primary key guarantees at most one match. Chapter 23 shows an estimate that is off by a large factor — and the plan is still correct, because a bad estimate can only make the engine slow, never wrong.

The invariant has a name in this repository and a test suite behind it. Removing any single pass from the pipeline must change how fast a query runs and nothing else; the differential tests in `tests/e2e/` run every query twice, once with a pass and once without, and compare the rows. [Chapter 28](28-plan-properties-and-ablation.md) is about that invariant and how to run the experiment yourself.

## Why the gap is so large

Ten thousand times is a suspicious number. It is worth understanding where it comes from, because it is not evenly distributed.

Cross-joining three tables produces a result whose size is the *product* of the inputs. The engine is not especially slow at building those five million rows — that measurement works out to roughly 340 rows per millisecond. It is that five million is a lot of rows to build in order to return five.

Add a fourth table and the product grows by another factor. This is why optimizer effort is worth spending: the cost of the *optimizer* grows with the number of tables in the query, which is small, while the cost of a bad *plan* grows with the product of their sizes, which is not. An optimizer that spends a millisecond to save fourteen seconds is not a close call.

It also means the gap on a two-table query with no filter is roughly nothing, which is the honest version of this chapter's headline. The optimizer earns its keep on queries with joins and selective predicates, and those are most queries anyone writes.

## In the code

| Idea | Where |
|---|---|
| The optimizer driver | [`Optimizer`](../../src/optimizer/optimizer.ts) |
| One pass's interface | [`OptimizationPass`](../../src/optimizer/pass.ts) |
| The default 24 registrations | [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) |
| Where the engine calls it | [`compileUncached`](../../src/engine/query-engine.ts) |
| Running a plan without optimizing | [`_collectRows`](../../src/engine/query-engine.ts) |
| Printing a plan | [`formatPlan`](../../src/planner/plan-formatter.ts) |

## Traps

**"Optimized" does not mean "optimal".** The optimizer applies rewrites it believes help and searches a bounded space of join orders. There is no claim anywhere in the codebase that the result is the best possible plan, and for queries with many tables it demonstrably is not — chapter 25 shows the search giving up and falling back to a greedy heuristic.

**A pass that does nothing is not a pass that is broken.** Most passes fire on a minority of queries. `SubqueryUnnesting` does nothing to a query with no subquery. Watching a pass leave the plan untouched tells you the query did not match its precondition, not that the pass is dead.

**The timings in this chapter are one machine, one measurement each.** They were taken in separate Node processes, with the optimized case reported as the best of five runs. Running the slow plan first in the same process leaves the page cache and the garbage collector in a state that makes the fast plan look hundreds of times worse than it is — a repeat of the optimized measurement immediately after the slow one came back at 1,926 ms instead of 1.4 ms. Any benchmark that runs both plans in one process without that care will report numbers that are wrong in an interesting direction.

## Exercises

1. Reproduce the two timings. Build with `npm run build:ts`, register the three tables, and run the raw plan and the optimized plan through `_collectRows` in *separate processes*. Then run them in the same process, slow one first, and explain the difference in the second number.

2. Add a fourth table to the `FROM` list with no join condition at all and predict the unoptimized runtime before measuring it. How close were you?

3. Print the plan after every pass with the observer from [chapter 2](../00-orientation/02-running-it-yourself.md) and count how many of the 24 registrations change the plan for this query. Then do it for `SELECT * FROM CUSTOMER`.

4. Find a query where the optimized and unoptimized plans have the same runtime to within noise. Explain what it is about the query that leaves the optimizer nothing to do.

5. Remove `JoinReorder` from the pipeline with `engine.optimizer.removePass('JoinReorder')`, re-optimize this chapter's query, and time it. Note that this only works before any statistics have been collected — chapter 28 explains why, and it is not obvious.

## Recap

- The logical planner transcribes the query; it does not improve it. `FROM a, b, c` becomes nested **cross joins** with every predicate stacked in one filter above them.
- The optimizer is a **function from plans to plans**, so any prefix of it can be run, and the unoptimized plan can be executed directly through [`_collectRows`](../../src/engine/query-engine.ts).
- Its 24 registrations divide into rewrites that are **always** good, rewrites that need **statistics**, and rewrites that make some queries **executable at all**.
- The gap between the two plans is a product versus a sum: a cross join builds the product of its inputs, so optimizer time grows with the number of tables while bad-plan time grows with their sizes multiplied.
- Every pass must preserve the answer exactly. That constraint, not performance, is what makes most of the passes in this part difficult.

Next: [chapter 15](15-passes-and-fixpoints.md) opens the driver up — how passes are registered, what a fixpoint stage is, and a real query where the fixpoint never converges.
