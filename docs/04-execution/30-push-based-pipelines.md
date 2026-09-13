# 30. Push-based pipelines

> After this chapter you will be able to look at a physical plan and say how many pipelines it becomes, which ones can run at the same time, and which operator ends each one.

## The question

Here is a table of 100,000 rows, which the storage layer holds as 49 chunks of 2,048. Run four queries against it and count the chunks the scan actually produces:

```
chunks in T: 49
SELECT A FROM T LIMIT 5                chunks scanned:   2 | rows 5
SELECT A FROM T LIMIT 5000             chunks scanned:   4 | rows 5000
SELECT A FROM T                        chunks scanned:  49 | rows 100000
SELECT A FROM T ORDER BY A LIMIT 5     chunks scanned:  49 | rows 5
```

The first line looks like laziness — the scan stopped early because nobody wanted more rows. It is not. **In this engine nobody ever asks for a row.** The scan is a loop that runs to completion on its own initiative and hands chunks downward; there is no consumer anywhere in the plan capable of declining one.

So the `LIMIT` cannot stop the scan by not asking. It has to reach back and interrupt it. Understanding why is the whole of this chapter, and every other chapter in Part 4 depends on it.

## Follow one batch

Consider a scan batch `[5, 20, 30]`, a filter `value > 10`, and a final ascending sort. The scan pushes three values into the filter. The filter passes the visible values `[20, 30]` to the sort, which stores them. When the scan reaches end of input, `finalize` travels through the filter to the sort. Only then can a full sort emit its result. With another scan batch still to come, even a small value such as 1 could change the first output row. This is a hand-worked dataflow trace; pipeline ids in an actual plan are separate bookkeeping.

## Push, not pull

The familiar way to build an execution engine is the **iterator model**, sometimes called Volcano: every operator has a `next()` method, the root calls `next()`, and each operator calls `next()` on its child to get the row it needs. Data is *pulled* up the tree.

This engine inverts that. Every operator is a [`Sink`](../../src/execution/execution-types.ts) — something you hand a chunk to:

```typescript
export interface Sink {
  consume(chunk: DataChunk): Promise<void>;
  finalize?(): Promise<void>;
  init?(): Promise<void>;
  error?(err: Error): void;
  cancelToken?: CancelToken;
}
```

`consume` takes a chunk. `finalize` says there will be no more. That is the entire protocol, and there is no `next`.

Operators are assembled by wrapping sinks. [`buildFilter`](../../src/execution/builders/pipeline-builders.ts) is the clearest example — it does not create a filter *node*, it creates a sink that filters and forwards:

```typescript
const childSink: Sink = {
  get cancelToken() { return currentSink.cancelToken; },
  async consume(chunk: DataChunk) {
    if (this.cancelToken?.isCancelled) return;
    const filtered = await filterOp.process(chunk);
    if (filtered && filtered.size > 0) {
      await currentSink.consume(filtered);
    }
  },
  async finalize() {
    if (currentSink.finalize) await currentSink.finalize();
  }
};
child.register(graph, currentPipelineId, childSink);
```

Read the last line carefully. The filter hands its *own* sink down to its child and asks the child to write into it. The direction of construction is top-down; the direction of data is bottom-up. `Filter` above `Scan` in the plan tree means the scan pushes into the filter's sink, which pushes into whatever is above.

A chain of sinks is a chain of ordinary function calls with no per-row state machine, so `Scan → Filter → Project` becomes one loop over a chunk with no dispatch between the stages. What it costs is control flow: stopping early and waiting for a whole input become things you design rather than get for free.

## What a pipeline is

At the bottom of every chain is something that is not a sink but a **source**: an async generator that produces chunks and pushes each one into the sink it was given.

```typescript
export type SourceGenerator = () => AsyncGenerator<DataChunk>;
```

[`buildScan`](../../src/execution/builders/source-builders.ts) creates one:

```typescript
const source: SourceGenerator = async function* () {
  for await (const chunk of scanOp.scan()) {
    if (currentSink.cancelToken?.isCancelled) break;
    await currentSink.consume(chunk);
    yield chunk;
  }
  if (currentSink.finalize) await currentSink.finalize();
};
graph.setSource(currentPipelineId, source);
```

A **pipeline** is one source plus the chain of sinks it feeds. Run the source to exhaustion and the pipeline is done. [`Pipeline`](../../src/execution/pipeline.ts) is the record:

```typescript
export interface Pipeline {
  id: number;
  sink: Sink;
  source: SourceGenerator | null;
  dependencies: Set<number>;
  dependents: Set<number>;
  state: PipelineState;
  cancelled: boolean;
}
```

Note that the generator both pushes into the sink *and* yields the chunk. The yield is what lets the scheduler drive the loop; nothing downstream reads the yielded value. [`drainSource`](../../src/execution/scheduler.ts) throws it away:

```typescript
async drainSource(pipeline: Pipeline): Promise<void> {
  if (!pipeline.source) return;
  for await (const _ of pipeline.source()) {
    if (pipeline.cancelled) return;
  }
}
```

## Where a pipeline ends

`Filter` and `Project` are **streaming**: a chunk goes in, a chunk comes out, and the operator holds nothing. They add a link to a chain and nothing else.

Some operators cannot do that. A sort cannot emit its first row until it has seen its last input row. Nor can a hash join's build side, or a hash aggregate. These are **blocking** operators, and each one ends a pipeline and begins another.

[`buildSort`](../../src/execution/builders/pipeline-builders.ts) shows the shape, and every blocking operator in the engine repeats it:

```typescript
const sortSink: Sink = {
  async consume(chunk: DataChunk) { await sortOp.consume(chunk); },
  async finalize() {}
};
const childPipelineId = graph.createPipeline(sortSink);
child.register(graph, childPipelineId, sortSink);

graph.addDependency(currentPipelineId, childPipelineId);

const source: SourceGenerator = async function* () {
  for await (const chunk of sortOp.stream()) {
    await currentSink.consume(chunk);
    yield chunk;
  }
  if (currentSink.finalize) await currentSink.finalize();
};
graph.setSource(currentPipelineId, source);
```

Four moves, in order: create a **new** pipeline whose sink swallows chunks into the sort; register the child into that new pipeline; declare that the current pipeline depends on it; and make the current pipeline's source be the sort's output stream.

The sort is a sink at the end of one pipeline and a source at the start of the next. That is the seam, and `addDependency` is what stops the second half from running before the first half has finished.

## The graph

[`PipelineGraph`](../../src/execution/pipeline.ts) holds the pipelines and the edges between them. Its interesting methods are three:

```typescript
createPipeline(sink: Sink): number
addDependency(pipelineId: number, dependsOnId: number): void
setSource(pipelineId: number, sourceGenerator: SourceGenerator): void
```

[`buildGraph`](../../src/execution/execution-context.ts) creates the graph, creates pipeline 1 with the [`ResultSink`](../../src/execution/result-sink.ts), and calls `register` on the compiled root. Everything else is built by the operators as they register themselves.

Trace those calls for the running query on the tiny dataset, where the plan is `Project → TopN → PerfectHashAggregate → NestedLoopJoin → (Filter → Scan, Scan)`:

```
create pipeline 1
create pipeline 2
create pipeline 3
create pipeline 4
pipeline 4 gets a source
pipeline 3 depends on 4
create pipeline 5
pipeline 5 gets a source
pipeline 3 depends on 5
pipeline 3 gets a source
pipeline 2 depends on 3
pipeline 2 gets a source
pipeline 1 depends on 2
pipeline 1 gets a source
```

Five pipelines, in a chain with one fork:

| Pipeline | Source | Sink at the end |
|---|---|---|
| 5 | scan of `ORDERS` | buffer for the join's inner side |
| 4 | scan of `CUSTOMER`, then `Filter` | buffer for the join's outer side |
| 3 | the nested loop join's output | the aggregate's hash table |
| 2 | the aggregate's finished groups | the top-N's sort buffer |
| 1 | the top-N's sorted output, then `Project` | the result |

`Project` does not appear as a pipeline because it is streaming — it is a sink inside pipeline 1.

Now the same query at 30,000 customers, where the join is a hash join:

```
create pipeline 1
create pipeline 2
create pipeline 3
create pipeline 4
pipeline 4 gets a source
pipeline 3 depends on 4
pipeline 3 gets a source
pipeline 2 depends on 3
pipeline 2 gets a source
pipeline 1 depends on 2
pipeline 1 gets a source
```

**Four pipelines, not five**, and the difference is the whole reason hash join is preferred at scale. A nested loop join has to buffer *both* inputs, so [`registerBufferedChild`](../../src/execution/builders/builder-utils.ts) is called twice and two pipelines are created. A hash join buffers only its build side; the probe side is registered into the *current* pipeline, because probing is streaming:

```typescript
graph.addDependency(currentPipelineId, buildPipelineId);
probeInput.register(graph, currentPipelineId, probeSink);
```

Pipeline 4 is the build; pipeline 3 is the scan of `ORDERS` pushing straight through the probe and into the aggregate without ever being materialized. That is what "the build side is blocking, the probe side is streaming" means concretely.

## Who owns the state of a run

Building the graph needs state that no single operator owns and no single operator may outlive: the plan behind every CTE name in scope, the chunks a CTE has already materialized so that a second reference does not recompute them, the profiler collecting per-operator timings, the exchange receivers a distributed fragment reads from.

Where that state lives is a design decision, and it has a wrong answer that looks right. The engine holds one executor for its whole life, so hanging the state off the executor and clearing it at the top of each run costs nothing and reads cleanly. It is wrong the moment two queries run at once, because "the top of each run" is not a point in time when runs overlap.

Two queries, each with a CTE named `C`, started together on one engine:

```typescript
const byPriority = (p) =>
  `WITH C AS (SELECT ID FROM ORDERS WHERE PRIORITY = ${p}) SELECT COUNT(*) AS N, MIN(ID) AS FIRST FROM C`;

const [low, high] = await Promise.all([engine.run(byPriority(1)), engine.run(byPriority(7))]);
```

Put the CTE state on the executor — exercise 6 walks you through it — and `C` means whichever query wrote it last:

```
PRIORITY = 1 -> [{"N":400,"FIRST":7}]
PRIORITY = 7 -> [{"N":400,"FIRST":7}]
```

No error and no warning: the first query answered with the second query's rows. Both counts are right, because both CTEs hold 400 rows. Only the identity of the rows is wrong, which is the kind of wrongness that survives a test suite.

So the state is split by **lifetime**, into three objects:

| Object | Lives as long as | Holds |
|---|---|---|
| [`ExecutionResources`](../../src/execution/execution-resources.ts) | the engine | catalog, temp space, storage backend, physical planner, worker pool, fragment pool |
| [`ExecutionContext`](../../src/execution/execution-context.ts) | one run | CTE definitions, materialized CTE results, compiled CTE pipelines, profiler, exchange receivers |
| [`QueryExecutor`](../../src/execution/query-executor.ts) | the engine | the resources, and a way to make contexts |

The executor is a factory and almost nothing else:

```typescript
newContext(options: ExecutionContextOptions = {}): ExecutionContext {
  return new ExecutionContext(this.resources, options);
}
```

Everything that used to be a field assignment before a run is an argument to the run instead. [`_collectRows`](../../src/engine/query-engine.ts) hands the CTE map and the profiler in through [`execute`](../../src/execution/query-executor.ts); [`executePlanInto`](../../src/distributed/execution/fragment-executor.ts) hands in that fragment's exchange receivers. Nothing is set on a shared object and unset around an `await`, which is the shape the bug had.

Builders receive the context rather than the executor — every `build*` function in `src/execution/builders/` takes `ctx: ExecutionContext` first — and the two-level access is deliberate:

```typescript
const storage = ctx.resources.catalog.getTableStorage(node.table);
const ctePlan = ctx.findCTEPlan(node.cteName);
```

`ctx.resources` is everyone's; anything reached directly on `ctx` is this run's. You can tell which one you are touching without leaving the line.

With one context per run, the same pair of queries answers for itself:

```
PRIORITY = 1 -> [{"N":400,"FIRST":1}]
PRIORITY = 7 -> [{"N":400,"FIRST":7}]
```

This is the oldest split in database engineering, and every engine draws it somewhere. PostgreSQL builds a fresh `EState` for each execution and reaches the catalog through process-wide caches. DuckDB gives each query an `ExecutionContext` that holds a reference to the longer-lived `ClientContext`. The names differ; the rule does not. **State whose correct value depends on which query is asking belongs to the query, not to the engine.**

The test for whether the line is drawn correctly is to ask of every field: if two queries ran at once, would they want the same value? The catalog, yes — a table is a table. The rows behind the name `C`, no.

## The scheduler

[`TaskScheduler`](../../src/execution/scheduler.ts) runs the graph:

```typescript
for (;;) {
  this.startReadyPipelines(pipelineGraph, running);

  if (running.size === 0) {
    if (this.countPending(pipelineGraph) > 0) {
      throw new Error('Pipeline deadlock detected: pending pipelines with unresolved dependencies.');
    }
    return;
  }

  const outcome = await Promise.race(running.values());
  running.delete(outcome.id);
  ...
  pipelineGraph.markPipelineDone(outcome.id);
}
```

[`getReadyPipelines`](../../src/execution/pipeline.ts) returns every pipeline that is `PENDING` with an empty dependency set. [`markPipelineDone`](../../src/execution/pipeline.ts) removes the finished pipeline's id from each dependent's set, which is what makes the next one ready. Up to `pipelineConcurrency` — four by default — run at once.

For the tiny plan, that produces:

```
ready: 4, 5
start 4
start 5
finish 4
finish 5
ready: 3
start 3
finish 3
ready: 2
start 2
finish 2
ready: 1
start 1
finish 1
```

The two scans run concurrently because neither depends on the other. Everything after that is a chain. The hash-join version has no fork and runs 4, 3, 2, 1 in order.

The deadlock check is worth noticing: if nothing is running and something is still pending, its dependencies can never be satisfied, so the scheduler raises rather than hanging. That converts a whole class of operator-construction bugs into an immediate error.

## Stopping early

Back to the opening question. Nothing pulls, so a `LIMIT` cannot stop its input by declining a chunk. [`buildLimit`](../../src/execution/builders/pipeline-builders.ts) instead creates a [`CancelToken`](../../src/execution/pipeline.ts) and hangs it off the sink it hands downward:

```typescript
const cancelToken = new CancelToken();
const childSink: Sink = {
  async consume(chunk: DataChunk) {
    if (cancelToken.isCancelled) return;
    await limitOp.consume(chunk);
    await emitPending();
    if (limitOp.done) {
      cancelToken.cancel();
    }
  },
  ...
  cancelToken,
};
```

Every operator between the limit and the source forwards that token — that is what the `get cancelToken()` accessor in `buildFilter` is for — and the scan's source loop checks it before producing each chunk. So the flag propagates down the sink chain by reference, and the scan notices on its next iteration.

That explains the numbers exactly. `LIMIT 5` is satisfied by the first chunk, but the token is only checked at the *top* of the next iteration, so the scan produces a second chunk before it stops: two chunks. `LIMIT 5000` needs three chunks of 2,048 and stops on the fourth. And `ORDER BY A LIMIT 5` scans all 49, because between the limit and the scan sits a blocking sort that must see every row before it can rank any of them — the limit's token never reaches the scan during the scan's own pipeline.

## Giving up on a query

A `LIMIT` stopping its input is a *success*: the query got what it asked for and the rows below it were never needed. Cancellation is the other thing — a caller has given up, no rows are wanted, and the query must end with an error rather than an answer. The two want the same machinery and opposite outcomes, so the engine gives them the same token type arranged in a tree.

Every run has a **query token**, held by its [`ExecutionContext`](../../src/execution/execution-context.ts). [`createPipeline`](../../src/execution/pipeline.ts) seeds it into each pipeline's sink, which is how it reaches past the blocking operators that deliberately absorb a limit's token. A `LIMIT` then hangs its own token off whatever it found there:

```typescript
const cancelToken = new CancelToken(currentSink.cancelToken ?? ctx.cancelToken);
```

The parent link is one-way. [`isCancelled`](../../src/execution/pipeline.ts) is true if the token or any ancestor is cancelled, so cancelling the query stops every limit beneath it, while a satisfied limit says nothing about the query. That one line of asymmetry is the whole distinction between "done early" and "abandoned".

A caller cancels with the platform's own type, an `AbortSignal`:

```typescript
const controller = new AbortController();
const rows = engine.run('SELECT ...', [], { signal: controller.signal });
controller.abort();
await rows;    // rejects with QueryCancelledError
```

[`CancelToken.fromSignal`](../../src/execution/pipeline.ts) bridges the two and hands back a detachable listener, so a long-lived signal does not accumulate one per query. [`TaskScheduler`](../../src/execution/scheduler.ts) checks the token before it starts each pipeline and after each one finishes, marks the running pipelines cancelled, and throws [`QueryCancelledError`](../../src/execution/pipeline.ts). Because the token belongs to the run and not to the engine, cancelling one query says nothing about the queries beside it.

### Cancelling something that is not waiting

There is a problem the token does not solve, and it is easy to miss because the code looks correct. A query that is busy is *computing*, not waiting on I/O. It awaits, constantly — but on promises that are already resolved, and those resolve on the microtask queue, which drains completely before the event loop reaches its timer or I/O phases. So `controller.abort()`, fired by a timer or by a client disconnecting, cannot run until the query is over. The token is checked faithfully and is never cancelled in time, because the cancellation never got a turn.

The fix is for the query to give the event loop a turn on purpose. [`drainSource`](../../src/execution/scheduler.ts) tracks a deadline and, between chunks, hands control back:

```typescript
if (cancelToken && Date.now() >= nextPollAt) {
  await yieldToEventLoop();
  nextPollAt = Date.now() + Config.cancelPollMs;
  if (cancelToken.isCancelled) return;
}
```

[`yieldToEventLoop`](../../src/runtime/platform.ts) is a `setImmediate` where there is one and a `setTimeout(0)` otherwise. `Date.now()` per chunk is cheap and, unlike a fixed chunk count, bounds the delay in the unit the caller cares about. The scheduler receives a token only when the run is interruptible — [`schedulerToken`](../../src/execution/execution-context.ts) is null unless somebody passed one in — so a query nobody can cancel pays for none of this.

Measured against 1,500,000 rows, aborting at a tenth of each query's own running time:

```
query                                full   abort at   stopped at
COUNT/SUM over a filter              90ms       9ms         12ms
GROUP BY, 1000 groups                98ms      10ms         11ms
SELECT DISTINCT                     136ms      14ms         21ms
ORDER BY, full sort                2423ms     242ms       1274ms
self-join, 4000 rows, 3 keys        566ms      57ms        622ms
```

The first three stop about when they were asked to. The last two are the honest limit of the design: **cancellation is delivered at chunk boundaries, and whatever happens between two of them runs to completion.** `ORDER BY` over 1.5M rows spends a second inside one sort with no chunk boundary in it, and you cannot interrupt a comparison sort from outside. The self-join scans 4,000 rows as two chunks and turns the second of them into five million output rows inside a single `process` call, so the abort lands after the work it wanted to prevent. Postgres has the same shape of problem and the same shape of answer — `CHECK_FOR_INTERRUPTS()` is only as good as the loops somebody remembered to put it in.

## In the code

| Idea | Where |
|---|---|
| Sink protocol | [`Sink`](../../src/execution/execution-types.ts) |
| Source protocol | [`SourceGenerator`](../../src/execution/execution-types.ts) |
| What a builder returns | [`CompiledPipeline`](../../src/execution/execution-types.ts) |
| Pipelines and their edges | [`PipelineGraph`](../../src/execution/pipeline.ts) |
| Running the graph | [`TaskScheduler`](../../src/execution/scheduler.ts) |
| Operator type to builder function | [`BUILDERS`](../../src/execution/execution-context.ts) |
| Wiring it all up | [`buildGraph`](../../src/execution/execution-context.ts) |
| State that belongs to one run | [`ExecutionContext`](../../src/execution/execution-context.ts) |
| State that belongs to the engine | [`ExecutionResources`](../../src/execution/execution-resources.ts) |
| A streaming operator | [`buildFilter`](../../src/execution/builders/pipeline-builders.ts) |
| A blocking operator | [`buildSort`](../../src/execution/builders/pipeline-builders.ts) |
| Buffering a whole child | [`registerBufferedChild`](../../src/execution/builders/builder-utils.ts) |
| Early termination and cancellation | [`CancelToken`](../../src/execution/pipeline.ts) |
| Bridging an `AbortSignal` | [`fromSignal`](../../src/execution/pipeline.ts) |
| Turning a cancelled token into an error | [`QueryCancelledError`](../../src/execution/pipeline.ts) |
| Letting an abort be delivered at all | [`yieldToEventLoop`](../../src/runtime/platform.ts) |
| Where rows end up | [`ResultSink`](../../src/execution/result-sink.ts) |

## Traps

**`register` is not `execute`.** Building the pipeline graph runs no query code. Every `register` implementation is pure wiring: it creates pipelines, allocates operator state, and closes over sinks. Nothing consumes a chunk until `TaskScheduler.schedule` runs. Setting a breakpoint in a builder tells you about planning, not about execution.

**Operator state is created in different places.** `buildSort` constructs its `SortOperator` inside `register`, because the sink needs it immediately; [`buildJoin`](../../src/execution/builders/join-builder.ts) constructs the merge join inside the source generator, after both sorted children have finished. A compiled pipeline can be registered more than once, so anything cached on an operator across runs is a bug.

**`finalize` is forwarded, not broadcast.** Each sink calls `currentSink.finalize()` from its own `finalize`. A sink that forgets to forward silently truncates the result, because the operator above never learns its input ended. This is the single most common way to break a new operator.

**Cancellation is cooperative and one chunk late.** The token is checked at loop boundaries, so a cancelled scan produces at most one extra chunk, and an operator that never checks the token ignores cancellation entirely.

**A cancelled source does not finalize.** [`scanSource`](../../src/execution/builders/builder-utils.ts) returns without calling `currentSink.finalize()` when the query token is cancelled, because finalizing a sort or an aggregate is exactly the expensive work the caller asked to stop. A limit-terminated scan still finalizes, and must: that is how the limit's buffered rows reach the result.

**One context is one run; one engine is many runs.** A [`QueryExecutor`](../../src/execution/query-executor.ts) is safe to share across overlapping queries. An [`ExecutionContext`](../../src/execution/execution-context.ts) is not, and neither is anything cached on one. Adding a field to the context declares that it belongs to a single run; adding one to [`ExecutionResources`](../../src/execution/execution-resources.ts) declares that concurrent runs may read and write it at the same time, and that claim needs an argument behind it.

**Pipeline ids say nothing about order.** They are allocated top-down during registration, so the root is 1 and the leaves have the highest numbers. Execution order is the reverse, and `getReadyPipelines` iterates insertion order, so with concurrency above 1 the interleaving is not determined by id.

## Recap

- Data is **pushed**: a source generator drives the loop and hands chunks to a [`Sink`](../../src/execution/execution-types.ts). There is no `next()` and nothing pulls.
- Operators are built **top-down** by wrapping sinks, so the tree is constructed from the root but data flows from the leaves.
- A **streaming** operator adds a link to a sink chain. A **blocking** operator — a sort, an aggregate, a hash join build — ends one pipeline and starts another.
- [`PipelineGraph`](../../src/execution/pipeline.ts) records those seams as **dependencies**, and [`TaskScheduler`](../../src/execution/scheduler.ts) runs any pipeline whose dependencies are all done, up to `pipelineConcurrency` at a time.
- A hash join costs one extra pipeline; a nested loop join costs two, because it buffers both inputs.
- Early termination is a **cancel token** passed down the sink chain by reference, which is why a `LIMIT` reads one chunk more than it needs and why a `LIMIT` above a `Sort` reads everything.
- **Early termination** and **cancellation** share the token type and differ by parentage: a limit's token is a child of the query token, so the query cancels the limit but never the reverse.
- A busy query starves the event loop, so an interruptible run **yields on purpose** between chunks — otherwise the abort cannot be delivered at all.
- Execution state is split by **lifetime**: [`ExecutionResources`](../../src/execution/execution-resources.ts) lasts as long as the engine, an [`ExecutionContext`](../../src/execution/execution-context.ts) lasts exactly one run, and builders take the context so that per-run state cannot be shared by accident.

Next: [chapter 31](31-vectorized-execution.md) looks inside a single `consume` call and asks why a chunk is 2,048 rows.
