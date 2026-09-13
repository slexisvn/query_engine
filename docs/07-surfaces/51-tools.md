# 51. Tools: CLI, REPL, and the visualizer

> After this chapter you will be able to choose an inspection tool for a question, reproduce an optimizer step, and distinguish a missing display field from missing engine work.

## The question

The query returned the right totals, but why did its filter move? A result table cannot answer that. A final plan shows where it ended up, but not which pass moved it. Different tools expose different points in the query's life.

| Question | Use |
|---|---|
| What rows did this SQL return? | REPL or `engine.run` |
| What logical and physical plan was selected? | SQL `EXPLAIN` |
| Which estimates disagree with observed row counts? | SQL `EXPLAIN ANALYZE` |
| Which pass changed a node? | optimizer observer or visualizer trace |
| What plan have my DataFrame calls constructed so far? | `DataFrame.explain()` |

[Chapter 2](../00-orientation/02-running-it-yourself.md) contains installation and launch commands. Here we use the tools as an investigation sequence.

## Follow one filter

Start with `npm run book:plan`. In the original logical tree, the segment filter consumes the join result. The observer shows a `PredicatePushdown` event after which that filter consumes the customer scan instead. Later events move the limit and fuse it with the sort.

For the chapter 1 input, the hand-worked row counts are:

| Stage | Original placement | Filter on customer input |
|---|---:|---:|
| customers read | 3 | 3 |
| customers passed to join | 3 | 2 |
| rows produced by join | 4 | 3 |
| rows reaching aggregation | 3 | 3 |
| final groups | 2 | 2 |

The final groups agree. The reduced intermediate join work explains the transformation's purpose. On these tiny tables, wall-clock timing is mostly setup and noise; it is a poor way to judge the rewrite.

The runnable [observer script](../examples/inspect-plan.mjs) collects statistics first and compares `formatPlan(event.before)` with `formatPlan(event.after)`. It prints only visibly changed trees. That is useful, but it intentionally misses metadata-only changes: a pass can set scan projections, pruning conditions, or estimates without changing those strings. Inspect the corresponding node fields or the visualizer's annotations when those are the subject of the experiment.

## Use the visualizer with its own fixture

After `npm --prefix tools/visualizer ci`, start `npm run viz` and open the printed URL. The bundled example named **Pushdown and Top-N** uses a filter containing `1 = 1`, a join, an ordering, and a limit. Its SQL is listed in [examples.ts](../../tools/visualizer/src/content/examples.ts).

Follow three changes: simplification removes the true conjunct, pushdown moves the segment filter, and Top-N fusion combines sort with limit. Before inspecting a step, predict which node can legally change and why. Then inspect the before and after plans. A pass with no visible change is still informative: its conditions may not apply, or another pass may already have done the work.

The visualizer's loaded data and catalog can differ from the book's three-customer fixture. Do not expect identical estimates or join choices merely because the SQL looks similar. When comparing two surfaces, align data, schemas, statistics, configuration, and whether you are looking at a raw, optimized, or physical plan.

## Read measurements at the right level

`EXPLAIN ANALYZE` executes the query. Its operator profiles include estimated and actual rows, chunks, and timing of output events. The profile is valuable for finding where row counts diverge, but it is not a complete accounting of parsing, statistics collection, memory, I/O, and CPU time. Check [ExecutionProfile](../../src/execution/execution-profile.ts) and [chapter 13](../02-logical-plan/13-reading-explain.md) before interpreting a displayed number.

For a reproducible report, save the exact SQL, input-generation recipe, relevant environment variables, Node version, and commit. Include the result as well as the plan when correctness is in question. A screenshot alone rarely records enough state to reproduce a planner choice.

## In the code

| Surface | Source |
|---|---|
| REPL commands | [`startREPL`](../../src/cli/repl.ts) |
| detailed logical plan text | [`formatPlan`](../../src/planner/plan-formatter.ts) |
| compact logical plan text | [`planToString`](../../src/planner/logical-plan.ts) |
| physical plan text | [`physicalPlanToString`](../../src/execution/physical-plan.ts) |
| profiler | [`ExecutionProfiler`](../../src/execution/execution-profile.ts) |
| visualizer application | [App.tsx](../../tools/visualizer/src/App.tsx) |
| visualizer examples | [examples.ts](../../tools/visualizer/src/content/examples.ts) |

## Traps

**A displayed plan is a view of state.** Omitted metadata is not evidence that an optimization did nothing.

**An observed row count and an estimate have different authority.** An estimate guides planning. A row count records what that execution produced, which can still be wrong if the query or engine is wrong.

**Timing a first run includes different work.** Statistics, compilation, module loading, and warmed code can make later runs differ. State which runs you measured.

## Recap

- Choose the tool according to the stage you need to inspect.
- Use intermediate row counts to understand work before relying on timings.
- A textual plan omits information; inspect metadata when necessary.
- Reproduction requires the data and settings as well as the SQL.

Next: [chapter 52](52-testing.md) turns these observations into checks that survive future changes.
