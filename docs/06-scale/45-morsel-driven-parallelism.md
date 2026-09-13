# 45. Morsel-driven parallelism

> After this chapter you will be able to say which parts of a query this engine runs on more than one thread, how work is handed out to those threads, and why the knob named `QE_MORSEL_SIZE` is not what controls it.

## The question

Load 240,000 orders, turn on worker threads, and run a filtered count:

```sql
SELECT COUNT(*) FROM ORDERS o WHERE o.O_TOTALPRICE > 100000
```

Now instrument [`FilterOperator`](../../src/execution/operators/filter.ts) and count how many times its `process` method runs. Single-threaded, it runs 118 times — once per chunk, because 240,000 rows at 2,048 rows per chunk is 118 chunks. With worker threads enabled it runs **zero** times:

```
parallel=true  result={"count_star":118030}  FilterOperator.process=0    runAggregate=1 (240000 rows)  857.2ms
parallel=false result={"count_star":118030}  FilterOperator.process=118  runAggregate=0 (0 rows)       684.9ms
```

Same answer. And the plan has not changed — there is still a `Filter` node in it:

```
-> Project (COUNT_STAR())
  -> Aggregate (aggs: COUNT_STAR())
    -> Filter (condition: (O.O_TOTALPRICE > 100000))
      -> Seq Scan on ORDERS as O

Physical Plan:
Project
  UngroupedAggregate
    Filter
      TableScan
```

So the filter runs, and the operator the physical plan names does not run it. Where did it go?

Two other things in that output are worth holding onto. The parallel run was **slower**. And the filter did not disappear into some generic thread pool — it disappeared into one specific call, `runAggregate`.

## Claiming a morsel

With ten input chunks and three chunks per morsel, workers can claim ranges `[0,3)`, `[3,6)`, `[6,9)`, and `[9,10)`. Each atomic claim reserves a disjoint range before the worker starts processing it. A faster worker may claim several ranges while another processes one. This hand-worked schedule explains load balancing without assuming that worker 1 always receives the first rows.

## What actually ran

The engine does not parallelize operator by operator. It looks for a **fragment**: a chain of scan, filter, and projection ending at a table, with an aggregate on top. [`extractScanChain`](../../src/execution/fragment-spec.ts) walks down from the aggregate's child and accepts exactly three node types:

```typescript
while (current) {
  if (current.type === PlanNodeType.FILTER) {
    stages.push({ kind: StageKind.FILTER, condition: current.condition });
    current = current.children[0];
  } else if (current.type === PlanNodeType.PROJECT) {
    stages.push({ kind: StageKind.PROJECT, expressions: current.expressions });
    current = current.children[0];
  } else if (current.type === PlanNodeType.SCAN) {
    stages.reverse();
    return { table: current.table, alias: ..., scanColumns: current.columns, stages };
  } else {
    return null;
  }
}
```

Anything else — a join, a sort, a CTE — and it returns `null`, and the serial plan runs unchanged. When it succeeds, [`buildFragmentSpec`](../../src/execution/fragment-spec.ts) turns the chain plus the aggregate into a `FragmentSpec`: a plain data structure holding bound expressions, no operators. That structure is `postMessage`d to every worker thread, and each worker calls [`instantiateFragment`](../../src/execution/fragment-spec.ts) to build its *own* filter and projection operators from it:

```typescript
operators.push(new FilterOperator(stage.condition, evaluator, mapping, null));
```

So the filter absolutely runs — eleven times over, once per worker, on eleven private `FilterOperator` instances. The one the main thread built is discarded. This is the difference between parallelizing an operator and parallelizing a **plan fragment**, and it is why the count in the opening is zero rather than smaller.

Note the `null` in that constructor call. Inside a worker there is no further parallel dispatch; the recursion stops at one level.

## One counter, many threads

Each worker now has a copy of the plan fragment and a view of the same input chunks. What stops two workers from aggregating the same chunk twice?

[`MorselScheduler`](../../src/parallel/morsel-scheduler.ts) is 42 lines and answers that with a single shared integer:

```typescript
constructor(totalUnits: number, unitsPerMorsel: number) {
  this.totalUnits = totalUnits;
  this.unitsPerMorsel = Math.max(1, unitsPerMorsel | 0);
  this.counter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

next(): MorselRange | null {
  const start = Atomics.add(this.counter, 0, this.unitsPerMorsel);
  if (start >= this.totalUnits) return null;
  return { start, end: Math.min(start + this.unitsPerMorsel, this.totalUnits) };
}
```

A **morsel** is a half-open range of chunk indices. `Atomics.add` returns the value *before* the addition, so every caller that reaches the counter gets a distinct starting offset, on any thread, with no lock and no message to the coordinator. [`descriptor`](../../src/parallel/morsel-scheduler.ts) hands the `SharedArrayBuffer` across the thread boundary and [`attach`](../../src/parallel/morsel-scheduler.ts) rebuilds a scheduler around it on the other side, so all eleven workers are incrementing one four-byte cell.

This is why the design is called *morsel-driven* rather than *range-partitioned*. Nobody decides in advance which worker gets which chunks. A worker that finishes early comes back and takes the next morsel, so a slow chunk — one with many surviving rows, or one whose column had to be decoded — costs the query the time of one morsel, not the time of one eleventh of the table.

The overshoot is deliberate and observable. For the query above, the shared counter reads 208 after the aggregate finishes:

```
scheduler: totalUnits=118 unitsPerMorsel=8 morsels=15 counterAfter=208
```

118 chunks in morsels of 8 is 15 real morsels, covering indices 0–117. But 208 ÷ 8 = 26 successful `Atomics.add` calls. The other eleven claims came back with `start >= totalUnits`, returned `null`, and the worker stopped — **exactly one wasted claim per worker**, which is the price of not having any other termination protocol. Running past the end is how a worker learns there is no more work.

## Where the morsel size comes from

`unitsPerMorsel` was 8 above. It is derived, not configured:

```typescript
const unitsPerMorsel = Math.max(1, Math.round(this.morselRows / DEFAULT_CHUNK_SIZE));
```

[`FragmentPool`](../../src/parallel/fragment-pool.ts) takes `morselRows` from `Config.aggMorselRows` — 16,384 by default, set by `QE_AGG_MORSEL_ROWS` — and divides by the 2,048-row chunk size from [chapter 31](../04-execution/31-vectorized-execution.md). 16,384 ÷ 2,048 = 8. A morsel is therefore about 16,384 rows, expressed as a count of chunks, because chunks are the unit the scheduler actually indexes.

And now the knob in the chapter's promise. [`src/config.ts`](../../src/config.ts) also defines `morselSize`, exposed as `QE_MORSEL_SIZE`, defaulting to 262,144. Grep for its only use:

```
src/parallel/parallel-dispatch.ts: const morselCount = Math.max(workerCount, Math.ceil(totalCount / Config.morselSize));
```

That line is inside [`_splitRange`](../../src/parallel/parallel-dispatch.ts), which belongs to a different mechanism entirely — and one that never runs. Setting `QE_MORSEL_SIZE` changes nothing about the morsels described above.

## The dispatcher that never dispatches

[`ParallelDispatch`](../../src/parallel/parallel-dispatch.ts) is the other half of `src/parallel/`. It splits a single *column* across threads and runs a WebAssembly kernel on each piece — a filter, a scalar aggregate, an arithmetic projection. It is wired into [`FilterOperator`](../../src/execution/operators/filter.ts) and [`ProjectionOperator`](../../src/execution/operators/projection.ts), and it has its own gate:

```typescript
canParallelize(operation: string, dataType: string, count: number): boolean {
  if (!this.workerPool || count < Config.parallelThreshold) return false;
  if (!PARALLELIZABLE_TYPES.has(dataType)) return false;
  ...
}
```

`Config.parallelThreshold` is 10,000 rows. The unit it is compared against is one chunk, and a chunk holds 2,048 rows. The threshold can never be met.

It is worse than that for comparisons, where the filter asks the question with a hardcoded count:

```typescript
if (!this.parallelDispatch!.canParallelize(operation, dataType, 1)) return null;
```

Traced through a live query, both branches are visible:

```
projection then filter (no aggregate)
  rows=3 process=1 plansBuilt=0 filterParallel=0 workerPool.execute=0
  canParallelize: filterGt/FLOAT64/n=1->false
between, no aggregate
  rows=3 process=1 plansBuilt=1 filterParallel=1 workerPool.execute=0
  canParallelize: filterBetween/INT32/n=2048->false
```

`n=1` for the comparison, because of the hardcoded argument; `n=2048` for `BETWEEN`, which skips the pre-check and asks with the real chunk size. Both are below 10,000, so both fall through to [`_filterFallback`](../../src/parallel/parallel-dispatch.ts), which calls the same WebAssembly kernel on the calling thread. The work still happens; the threads are not involved.

Sweep the query shapes and the pattern holds:

| Query | `workerPool.execute` | `fragmentPool.runAggregate` | `fragmentPool.runJoinStream` |
|---|---:|---:|---:|
| scan + filter + limit | 0 | 0 | 0 |
| projection arithmetic | 0 | 0 | 0 |
| grouped aggregate | 0 | 1 | 0 |
| ungrouped aggregate | 0 | 1 | 0 |
| hash join | 0 | 0 | 1 |
| sort | 0 | 0 | 0 |
| running example | 0 | 0 | 1 |

Every unit of real thread parallelism in this engine goes through `FragmentPool`. The `WorkerPool` that `ParallelDispatch` would use is started, sized, and given memory — chapter 46 measures how much — and receives nothing.

## What crosses the threshold

Two builders decide whether a fragment is worth shipping.

[`aggregate-builder.ts`](../../src/execution/builders/aggregate-builder.ts) checks the table's row count and a byte budget:

```typescript
const withinMemory = rowCount * parallel.estimatedRowBytes <= Config.parallelAggMemoryBytes;
if (rowCount < Config.parallelAggThreshold || !withinMemory) {
  serialCompiled.register(graph, currentPipelineId, currentSink);
  return;
}
```

[`join-builder.ts`](../../src/execution/builders/join-builder.ts) checks the *combined* size of both inputs and demands that the build side still fit in the row budget from [chapter 34](../04-execution/34-hash-join.md):

```typescript
const eligible = buildRows + probeRows >= Config.parallelJoinThreshold
  && buildRows <= buildBudget.rowCapacity;
```

Below either threshold the serial operator runs, and both builders keep the serial pipeline compiled and ready as a fallback — if `runAggregate` throws or declines, the query re-runs the serial sub-pipeline rather than failing.

Measured on this machine, eleven workers, medians of five runs:

| Query | serial | parallel |
|---|---:|---:|
| grouped aggregate over 240,000 rows | 58 ms | 59 ms |
| ungrouped aggregate | 36 ms | 64 ms |
| count with filter | 46 ms | 53 ms |
| hash join, 60,000 × 240,000 | 442 ms | 193 ms |
| running example | 293 ms | 315 ms |

The join is more than twice as fast. The aggregates are flat or worse. That is not a mystery once you know what the fragment pool has to do before a worker can look at a row — it has to get the data into shared memory, and chapter 46 measures that cost. The thresholds exist precisely because the transport is not free, and 50,000 rows is where the engine guesses the crossover is.

## In the code

| Idea | Where |
|---|---|
| Morsel handout | [`MorselScheduler`](../../src/parallel/morsel-scheduler.ts) |
| Claiming a morsel | [`next`](../../src/parallel/morsel-scheduler.ts) and [`drain`](../../src/parallel/morsel-scheduler.ts) |
| Sharing the counter across threads | [`descriptor`](../../src/parallel/morsel-scheduler.ts) / [`attach`](../../src/parallel/morsel-scheduler.ts) |
| Extracting a parallelizable subtree | [`extractScanChain`](../../src/execution/fragment-spec.ts) |
| Rebuilding it inside a worker | [`instantiateFragment`](../../src/execution/fragment-spec.ts) |
| Aggregate fan-out | [`runAggregate`](../../src/parallel/fragment-pool.ts) |
| Join fan-out | [`runJoinStream`](../../src/parallel/fragment-pool.ts) |
| The worker-side aggregate loop | [`handleAggregate`](../../src/parallel/fragment-worker.ts) |
| Column-level dispatch (dormant) | [`ParallelDispatch`](../../src/parallel/parallel-dispatch.ts) |
| Turning it all on | [`enableParallel`](../../src/engine/query-engine.ts) |

Configuration, all in [`src/config.ts`](../../src/config.ts):

| Setting | Default | Effect |
|---|---|---|
| `parallelWorkers` | CPU count − 1 | threads in both pools |
| `aggMorselRows` | 16384 | morsel size, in rows, for aggregates and joins |
| `parallelAggThreshold` | 50000 | rows below which an aggregate stays serial |
| `parallelJoinThreshold` | 50000 | build + probe rows below which a join stays serial |
| `parallelAggMemoryBytes` | 256 MB | ceiling on what may be shipped to workers |
| `parallelThreshold` | 10000 | gate on the dormant column-level path |
| `morselSize` | 262144 | read only by the dormant path |

## Traps

**`src/parallel/` is not `src/distributed/`.** Everything in this chapter is threads inside one operating-system process sharing one address space. The counter in `MorselScheduler` works because a `SharedArrayBuffer` is genuinely the same bytes on every thread. Nothing here survives a network hop, and chapters 47 through 49 do not reuse any of it.

**A morsel is measured in chunks, not rows.** `totalUnits` is the number of chunks in the input, and `unitsPerMorsel` is a chunk count. The row figure is only how that count was derived. A table stored in unusually small chunks gets unusually small morsels.

**The `Filter` node in the plan is not evidence that `FilterOperator` runs.** When the fragment path takes over, the plan is unchanged and the operators listed in it are rebuilt elsewhere. `EXPLAIN` describes the plan, not the schedule.

**Parallel is not automatically faster, and the engine knows it.** Three thresholds and a memory ceiling exist to keep small queries away from this path. The one row in the table above that is dramatically faster is the join, which is also the query that was doing the most work per byte transported.

## Recap

- Parallelism here is **fragment-level**, not operator-level: a scan/filter/project chain plus its aggregate is packaged as a `FragmentSpec` and rebuilt inside each worker, so the main thread's operators never run.
- A **morsel** is a range of chunk indices, handed out by a single `Atomics.add` on a shared `Int32Array`. There is no assignment step and no coordinator — workers race for the counter, and each one overshoots exactly once to discover the end.
- Morsel size comes from `QE_AGG_MORSEL_ROWS` divided by the 2,048-row chunk size. **`QE_MORSEL_SIZE` is read by a different, dormant mechanism** and has no effect on it.
- The column-level `ParallelDispatch` path cannot reach its own 10,000-row threshold, because it is asked one chunk at a time; it falls back to running the same kernel on the calling thread.
- All measured thread parallelism goes through `FragmentPool`, gated at 50,000 rows for aggregates and joins, with the serial pipeline kept as a live fallback.

Next: [chapter 46](46-workers-and-shared-memory.md) opens the two worker pools this chapter kept referring to, measures what enabling them costs before a single row is read, and follows a chunk across the thread boundary.
