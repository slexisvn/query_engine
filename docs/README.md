# Building a Query Engine

A book about how SQL becomes answers, written against a real engine you can read, run, and break.

Everything described here is implemented in the `src/` directory of this repository — roughly 39,000 lines of TypeScript covering a SQL frontend, a cost-based optimizer with 23 passes, a vectorized push-based execution engine, columnar storage with encoding and spilling, morsel-driven parallelism, and a distributed execution layer. There is no toy version. When a chapter explains hash join spilling, it explains the hash join that runs when you type a query.

## Who this is for

You can program. You have written SQL, or at least read some. You have never built a database and do not know what a "plan node" is. By the end you will be able to read any plan this engine produces, explain why the optimizer chose it, and add a pass or an operator of your own.

## How to read it

Start at chapter 1 and go in order — later parts assume the vocabulary of earlier ones. If you only have an afternoon, read Part 0, then chapter 17 (predicate pushdown) and chapter 34 (hash join): those two are the load-bearing ideas of the whole system.

One query runs through the entire book:

```sql
SELECT c.C_NAME, SUM(o.O_TOTALPRICE) AS TOTAL
FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE c.C_MKTSEGMENT = 'BUILDING'
GROUP BY c.C_NAME
ORDER BY TOTAL DESC
LIMIT 10
```

Every part returns to it and shows the same query one layer deeper.

---

## Part 0 — Orientation

| # | Chapter | |
|---|---|---|
| 1 | [What is a query engine?](00-orientation/01-what-is-a-query-engine.md) | ✅ |
| 2 | [Running it yourself](00-orientation/02-running-it-yourself.md) | ✅ |
| 3 | [A map of the codebase](00-orientation/03-map-of-the-codebase.md) | ✅ |
| 4 | [Rows, columns, and chunks](00-orientation/04-rows-columns-and-chunks.md) | ✅ |

## Part 1 — From text to tree

| # | Chapter | |
|---|---|---|
| 5 | [The lexer](01-frontend/05-the-lexer.md) | ✅ |
| 6 | [A recursive-descent parser](01-frontend/06-recursive-descent-parser.md) | ✅ |
| 7 | [The AST and why it isn't enough](01-frontend/07-the-ast-and-its-limits.md) | ✅ |
| 8 | [The binder: scopes and names](01-frontend/08-binder-scopes-and-names.md) | ✅ |
| 9 | [Types, coercion, and expressions](01-frontend/09-types-and-expressions.md) | ✅ |

## Part 2 — The logical plan

| # | Chapter | |
|---|---|---|
| 10 | [Relational algebra in twenty minutes](02-logical-plan/10-relational-algebra.md) | ✅ |
| 11 | [The logical plan nodes](02-logical-plan/11-the-logical-plan-nodes.md) | ✅ |
| 12 | [Building the plan](02-logical-plan/12-building-the-plan.md) | ✅ |
| 13 | [Reading EXPLAIN](02-logical-plan/13-reading-explain.md) | ✅ |

## Part 3 — The optimizer

| # | Chapter | |
|---|---|---|
| 14 | [Why optimize at all](03-optimizer/14-why-optimize.md) | ✅ |
| 15 | [Passes and fixpoints](03-optimizer/15-passes-and-fixpoints.md) | ✅ |
| 16 | [Expression simplification](03-optimizer/16-expression-simplification.md) | ✅ |
| 17 | [Predicate pushdown](03-optimizer/17-predicate-pushdown.md) | ✅ |
| 18 | [Inference, null rejection, and outer-to-inner](03-optimizer/18-inference-and-outer-to-inner.md) | ✅ |
| 19 | [Projection, limit, and the cleanup passes](03-optimizer/19-projection-limit-and-cleanup.md) | ✅ |
| 20 | [Eliminating work entirely](03-optimizer/20-eliminating-work.md) | ✅ |
| 21 | [Access paths and orderings](03-optimizer/21-access-paths-and-orderings.md) | ✅ |
| 22 | [Statistics](03-optimizer/22-statistics.md) | ✅ |
| 23 | [Cardinality estimation](03-optimizer/23-cardinality-estimation.md) | ✅ |
| 24 | [The cost model](03-optimizer/24-the-cost-model.md) | ✅ |
| 25 | [Join ordering: hypergraphs and DPhyp](03-optimizer/25-join-ordering.md) | ✅ |
| 26 | [Subquery unnesting](03-optimizer/26-subquery-unnesting.md) | ✅ |
| 27 | [Dependent joins and decorrelation](03-optimizer/27-dependent-joins-and-decorrelation.md) | ✅ |
| 28 | [Plan properties and the ablation invariant](03-optimizer/28-plan-properties-and-ablation.md) | ✅ |

## Part 4 — Execution

| # | Chapter | |
|---|---|---|
| 29 | [From logical to physical](04-execution/29-logical-to-physical.md) | ✅ |
| 30 | [Push-based pipelines](04-execution/30-push-based-pipelines.md) | ✅ |
| 31 | [Vectorized execution: why 2048](04-execution/31-vectorized-execution.md) | ✅ |
| 32 | [Scans and zone maps](04-execution/32-scans-and-zone-maps.md) | ✅ |
| 33 | [Filters and expression evaluation](04-execution/33-filters-and-expression-evaluation.md) | ✅ |
| 34 | [Hash join](04-execution/34-hash-join.md) | ✅ |
| 35 | [Merge join, nested loop, and join semantics](04-execution/35-other-joins.md) | ✅ |
| 36 | [Aggregation](04-execution/36-aggregation.md) | ✅ |
| 37 | [Sorting and top-N](04-execution/37-sorting-and-topn.md) | ✅ |
| 38 | [Window functions and frames](04-execution/38-window-functions.md) | ✅ |
| 39 | [Memory budgets and spilling](04-execution/39-memory-and-spilling.md) | ✅ |

## Part 5 — Storage

| # | Chapter | |
|---|---|---|
| 40 | [Columnar tables](05-storage/40-columnar-tables.md) | ✅ |
| 41 | [Encodings](05-storage/41-encodings.md) | ✅ |
| 42 | [Pages, caching, and the B-tree](05-storage/42-pages-caching-and-btree.md) | ✅ |
| 43 | [Serialization and spill files](05-storage/43-serialization-and-spill.md) | ✅ |
| 44 | [Storage backends: the same core in a browser](05-storage/44-storage-backends.md) | ✅ |

## Part 6 — Scaling out

| # | Chapter | |
|---|---|---|
| 45 | [Morsel-driven parallelism](06-scale/45-morsel-driven-parallelism.md) | ✅ |
| 46 | [Workers and shared memory](06-scale/46-workers-and-shared-memory.md) | ✅ |
| 47 | [Fragments and exchange operators](06-scale/47-fragments-and-exchange.md) | ✅ |
| 48 | [Partitioning and partition pruning](06-scale/48-partitioning-and-pruning.md) | ✅ |
| 49 | [Transport and cluster health](06-scale/49-transport-and-cluster-health.md) | ✅ |

## Part 7 — Surfaces and quality

| # | Chapter | |
|---|---|---|
| 50 | The DataFrame API | |
| 51 | Tools: CLI, REPL, and the visualizer | |
| 52 | Testing a query engine | |
| 53 | Debugging a wrong plan | |
| 54 | The WASM slot that is currently empty | |

## Appendix

| Chapter | |
|---|---|
| The SQL grammar this engine accepts | |
| Configuration reference | |
| Glossary | |
| Further reading | |

---

## Contributing a chapter

Read [CONVENTIONS.md](CONVENTIONS.md) first. It specifies the chapter template, the code-reference format, and the rule that every plan printed in the book must be real engine output rather than something written by hand.

Before committing:

```bash
npm run check:docs
```

That verifies every file path referenced from the book still exists and every symbol named in a link is still defined in the file it points at. A rename that breaks a chapter fails CI, which is how the book stays true as the engine changes.
