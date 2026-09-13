# 47. Fragments and exchange operators

> After this chapter you will be able to read a distributed plan, say where it was cut and why, and explain why `SUM` splits in two but `AVG` has to become something else first.

## The question

Start a coordinator and two worker processes. Each worker loads half the orders — 120,000 rows apiece, split round-robin — and the coordinator loads none. Then ask for an average:

```sql
SELECT o.O_ORDERDATE, SUM(o.O_TOTALPRICE) AS T, AVG(o.O_TOTALPRICE) AS A
FROM ORDERS o GROUP BY o.O_ORDERDATE ORDER BY T DESC
```

```
+-------------+--------------------+-------------------+
| O_ORDERDATE | T                  | A                 |
+-------------+--------------------+-------------------+
| 1997-01-01  | 3416627027.4500017 | 99650.7912106983  |
| 1993-01-01  | 3414082185.7600045 | 99576.56727993947 |
| 1994-01-01  | 3413833514.220003  | 99569.31442046326 |
| 1998-01-01  | 3413577116.17      | 99564.74015371154 |
| 1996-01-01  | 3412674474.170009  | 99535.50936738054 |
| 1995-01-01  | 3409107992.220002  | 99431.48784401803 |
| 1992-01-01  | 3405267036.6500063 | 99322.3577847457  |
+-------------+--------------------+-------------------+
7 row(s) returned.

Executed in 112.54 ms [2 worker(s)]
```

The same query on one machine with all 240,000 rows:

```
| 1997-01-01  | 3416627027.4500093 | 99650.79121069852 |
| 1993-01-01  | 3414082185.7599983 | 99576.56727993928 |
| 1994-01-01  | 3413833514.22001 | 99569.31442046344 |
| 1998-01-01  | 3413577116.170009 | 99564.7401537118 |
| 1996-01-01  | 3412674474.169986 | 99535.50936737985 |
| 1995-01-01  | 3409107992.2199993 | 99431.48784401795 |
| 1992-01-01  | 3405267036.64998 | 99322.35778474493 |
```

The first eleven significant figures agree on every row; the digits after that do not, which is what you expect when the same floating-point additions happen in a different order. The averages are right, and no node ever saw more than half the rows.

That should bother you. `SUM` composes — a sum of sums is a sum. `AVG` does not: the average of two averages is the true average only when both halves have the same number of rows, and nothing guarantees that. The worker logs say each worker returned 7 rows, one per date. Whatever those 7 rows held, it was not an average.

## What crosses the exchange

Suppose one worker sees amounts `[10,20]` and another sees `[100]`. Sending partial SUM values 30 and 100 is sufficient to produce 130. Sending partial averages 15 and 100 is insufficient without their counts: averaging them would give 57.5 instead of `130/3`. Sending `(sum,count)` pairs `(30,2)` and `(100,1)` gives the final stage enough information. This hand-worked example is the reason an exchange's schema may describe aggregate state rather than final query columns.

## Distribution is more passes

Before anything is cut up, note where the distributed rewrites live. [`enableDistributed`](../../src/engine/query-engine.ts) does not build a second compiler. It adds six passes to the existing pipeline:

```typescript
const makeDistributedPasses = (): DistributedPassEntry[] => [
  { method: 'insertPassAfter', args: [PLAN_PROPERTIES_PASS, new DistributionAwareJoin(partitionMap, statsMap)] },
  { method: 'registerPass', args: [new PartialAggregatePass()] },
  { method: 'registerPass', args: [new DistributedSortPass()] },
  { method: 'registerPass', args: [new DistributedDistinctPass(partitionMap)] },
  { method: 'registerPass', args: [new DistributedSetOpPass(partitionMap)] },
  { method: 'registerPass', args: [new DistributedLimitPass(partitionMap)] },
];
```

[`registerPass`](../../src/optimizer/optimizer.ts) appends a stage; [`insertPassAfter`](../../src/optimizer/optimizer.ts) splices one in by name. Ask the optimizer for its pass list before and after:

```
single-node passes: 24
distributed passes: 30
...
21. PlanProperties
22. DistributionAwareJoin   <- added by enableDistributed
23. SortElimination
24. TopNFusion
25. ScanPruning
26. PartialAggregate   <- added by enableDistributed
27. DistributedSort   <- added by enableDistributed
28. DistributedDistinct   <- added by enableDistributed
29. DistributedSetOp   <- added by enableDistributed
30. DistributedLimit   <- added by enableDistributed
```

Everything [chapter 15](../03-optimizer/15-passes-and-fixpoints.md) says about passes still applies: tree rewrites, fixed order, and one of them placed deliberately — `DistributionAwareJoin` must see the plan properties computed immediately before it. The only new machinery is a gate. [`DistributedRewritePass`](../../src/distributed/optimizer/distributed-pass.ts) checks a flag on the root:

```typescript
override apply(plan: LogicalPlanNode): LogicalPlanNode {
  if (!isDistributed(plan)) return plan;
  return this._createRewriter().rewrite(plan);
}
```

[`markDistributed`](../../src/distributed/distributed-types.ts) sets `_distributed = true`, and the coordinator sets it on every plan it compiles. So the same engine object can answer a local query and a distributed one; the six extra passes do nothing on plans that were not marked.

## Splitting an aggregate in two

[`PartialAggregatePass`](../../src/distributed/optimizer/partial-aggregate.ts) replaces one `Aggregate` node with three. Optimized, the query above plans to this:

```
Project
  MergeExchange(limit=null)
    Sort
      FinalAggregate(final)
        Exchange(hash_shuffle)
          PartialAggregate(partial)
            Scan(ORDERS AS O)
```

The three middle nodes are the rewrite: `PartialAggregate → Exchange → FinalAggregate` standing where the `Aggregate` was. The `Sort` beneath a `MergeExchange` is the `ORDER BY` receiving the same local-then-global treatment from a different pass, which is [chapter 48](48-partitioning-and-pruning.md)'s subject.

The rewrite is unconditional in shape but conditional in eligibility. [`DECOMPOSABLE_FUNCTIONS`](../../src/planner/aggregate-decomposition.ts) is the whole table:

| SQL function | partial | final |
|---|---|---|
| `SUM` | `SUM` | `SUM` |
| `COUNT` | `COUNT` | **`SUM`** |
| `COUNT(*)` | `COUNT_STAR` | **`SUM`** |
| `MIN` | `MIN` | `MIN` |
| `MAX` | `MAX` | `MAX` |
| `AVG` | **`AVG_PARTIAL`** | **`AVG_FINAL`** |

Three of these are self-similar and unsurprising. `COUNT` is the first hint that the two halves need not be the same function — counting counts would be wrong, so the final stage sums them.

`AVG` cannot be expressed in this table at all, and the code says so by inventing two functions that do not exist in SQL. [`_buildPartialAggregates`](../../src/distributed/optimizer/partial-aggregate.ts) tags the partial with the columns it will emit:

```typescript
if (funcName === 'AVG') {
  return { ...agg, func: decomp.partial, _originalIndex: idx, _emitColumns: ['_sum', '_count'] };
}
```

[`buildPartialAggregate`](../../src/execution/builders/aggregate-builder.ts) honors that by expanding one aggregate into two accumulators and two output columns:

```typescript
if (funcName === 'AVG_PARTIAL') {
  aggDefs.push({ name: 'SUM', ..., createAccumulator: getAccumulatorFactory('SUM'), extractValue: extract });
  aggDefs.push({ name: 'COUNT', ..., createAccumulator: getAccumulatorFactory('COUNT'), extractValue: extract });
  aggSchemaCols.push({ name: '_avg_sum', dataType: DataType.FLOAT64, tableAlias: '' });
  aggSchemaCols.push({ name: '_avg_count', dataType: DataType.FLOAT64, tableAlias: '' });
  ...
}
```

So the 7 rows each worker sent were not averages. Each carried a date, a running sum, and a row count. [`buildFinalAggregate`](../../src/execution/builders/aggregate-builder.ts) reads both columns back as a pair and [`AvgFinalAccumulator`](../../src/execution/operators/hash-aggregate.ts) adds them separately, dividing only once, at the very end:

```typescript
add(pair: EvalValue | ColumnValue[]): void {
  const arr = pair as ColumnValue[];
  const s = arr[0], c = arr[1];
  if (s !== null && ... ) { this.sum += Number(s); this.count += Number(c); }
}
result(): ColumnValue { return this.count > 0 ? this.sum / this.count : null; }
```

That is the whole answer to the opening question. **Decomposing an aggregate sometimes means changing its intermediate type.** `SUM`'s intermediate value is a number, which is why it looks trivial. `AVG`'s is a pair, and once the partial and final stages may speak a private language, `AVG` decomposes as cleanly as `SUM`. The same `{ sum, count }` state is what [`AvgAccumulator`](../../src/execution/operators/hash-aggregate.ts) already exported for the thread-parallel path in [chapter 46](46-workers-and-shared-memory.md) — one mechanism, two transports.

Because partial rows are per-group, what crosses the network is the number of groups, not the number of rows: 7 rows per worker instead of 120,000.

### What cannot be split

[`_canDecompose`](../../src/distributed/optimizer/partial-aggregate.ts) refuses two things:

```typescript
return aggregates.every(agg => {
  if (agg.distinct) return false;
  const funcName = aggregateFunctionName(agg);
  return DECOMPOSABLE_FUNCTIONS.has(funcName);
});
```

A `DISTINCT` aggregate cannot be combined from partials, because two workers can each see the same value and neither knows it. The plan is left alone:

```
COUNT DISTINCT, distributed plan
-> Project (COUNT(O.O_CUSTKEY))
  -> Aggregate (aggs: COUNT(O.O_CUSTKEY))
    -> Seq Scan on ORDERS as O
```

No `PartialAggregate`, no `Exchange`. Every row will be shipped to whoever runs that `Aggregate`.

## Cutting the plan into fragments

The optimizer has now marked *where* a plan can be cut. [`DistributedPlanner`](../../src/distributed/planner/distributed-planner.ts) does the cutting. A [`Fragment`](../../src/distributed/planner/fragment.ts) is a plan subtree plus three pieces of routing:

```typescript
this.planRoot = planRoot;
this.targetNodes = targetNodes || [];
this.exchangeInputs = exchangeInputs || [];
this.outputPartitioning = outputPartitioning || null;
```

`targetNodes` is where it runs, `exchangeInputs` names the fragments it consumes, and `outputPartitioning` says where its rows go. A fragment with no inputs is a leaf; a fragment with no output partitioning is the root, which is always the coordinator.

[`fragmentize`](../../src/distributed/planner/distributed-planner.ts) walks the plan twice. `_processNode` computes, per node, which workers could run it — using [`runsOnWorkers`](../../src/distributed/planner/operator-capability.ts), which reads a capability off the node descriptor:

```typescript
switch (capability.input) {
  case InputRequirement.ROW_LOCAL: return true;
  case InputRequirement.PARTIAL_THEN_COMBINE: return input.combinedAbove;
  case InputRequirement.COLOCATED_GROUPS: return input.groupsColocated;
  case InputRequirement.GLOBAL: return false;
}
```

A filter is `ROW_LOCAL` and may run anywhere. An aggregate is `PARTIAL_THEN_COMBINE` and may run on a worker only if something above it will combine the partials — exactly what the `Exchange` node from `PartialAggregatePass` signals. A sort is `GLOBAL`.

Then [`_placeGathers`](../../src/distributed/planner/distributed-planner.ts) turns those decisions into fragments, replacing each pushed-down subtree with a `LogicalExchangeReceive` node naming the fragments that will feed it. For the query at the top of this chapter, with two workers:

```
Project
  MergeExchange(limit=null)
    Sort
      FinalAggregate(final)
        Exchange(hash_shuffle)
          PartialAggregate(partial)
            Scan(ORDERS AS O)

fragments: 3, root = 3
  fragment 1  target=[worker-19401]  output=hash_shuffle  inputs=[]
      PartialAggregate(partial)
        Scan(ORDERS AS O)
  fragment 2  target=[worker-19402]  output=hash_shuffle  inputs=[]
      PartialAggregate(partial)
        Scan(ORDERS AS O)
  fragment 3  target=[coordinator-19400]  output=root  inputs=[1:gather, 2:gather]
      Project
        MergeExchange(limit=null)
          Sort
            FinalAggregate(final)
              ExchangeReceive(fragments=[1,2])
```

Three things to notice.

**The `Exchange` node is gone from the fragments.** It marked the cut; the cut has been made. What remains is one subtree per worker below the line and one subtree above it, joined by `ExchangeReceive`.

**One fragment per node, not per plan.** Fragments 1 and 2 hold the *same* `planRoot` object and differ only in `targetNodes`. The plan is the program; the fragment is the invocation.

**The two sides disagree about the exchange type.** Fragment 1's `outputPartitioning` says `hash_shuffle`, inherited from the `Exchange` node; fragment 3's `exchangeInputs` say `gather`. [`_processExchange`](../../src/distributed/planner/distributed-planner.ts) writes both, and the consumer's view is the accurate one: with no `targetNodes` on the partitioning, [`_buildOutputConfig`](../../src/distributed/execution/coordinator.ts) defaults the destination to the coordinator, and a "shuffle" to one destination is a gather. Chapter 49 measures what that costs.

Running it, the fragment ids show up in the worker logs:

```
[fragment] Received fragment 4
[fragment] Fragment 4 completed: 7 rows in 54.15 ms
```

Seven rows: one partial record per date, exactly as predicted.

## Who actually moves the bytes

There is a plausible-looking answer that is wrong. [`buildExchange`](../../src/execution/builders/exchange-builders.ts) can build an [`ExchangeSender`](../../src/distributed/execution/exchange-operator.ts) or an [`ExchangeReceiver`](../../src/distributed/execution/exchange-operator.ts) around an `Exchange` node — but only when the run was given a `distributedContext`. That is one of the options [`ExecutionContext`](../../src/execution/execution-context.ts) accepts, and nothing in `src/` passes it. The only caller in the repository is a unit test asserting that a context keeps the one it was handed, so no query reaches those branches and `buildExchange` always takes its last one:

```typescript
return {
  schema: child.schema,
  columnMapping: child.columnMapping,
  register: (graph, currentPipelineId, currentSink) => {
    child.register(graph, currentPipelineId, currentSink);
  }
};
```

An `Exchange` node compiles to nothing. The same is true of `MergeExchange`, which means [`MergeExchangeOperator`](../../src/distributed/execution/merge-exchange.ts) and its k-way sorted merge are exercised only by the tests.

The transfer is done one level up, by [`FragmentExecutor`](../../src/distributed/execution/fragment-executor.ts), which knows nothing about plan nodes and everything about fragments. Before running, [`_setupReceivers`](../../src/distributed/execution/fragment-executor.ts) creates one `ExchangeReceiver` per declared input, on a channel named after the source fragment:

```typescript
const channelId = fragmentOutputChannel(input.sourceFragmentId);
```

`frag-1-output`, `frag-2-output`. Those receivers are handed to [`executePlanInto`](../../src/distributed/execution/fragment-executor.ts), which puts them on the context it builds that fragment with — so two fragments running on one node at the same time cannot read each other's channels, for the reason [chapter 30](../04-execution/30-push-based-pipelines.md) gives. [`buildExchangeReceive`](../../src/execution/builders/exchange-builders.ts) then looks each one up by fragment id to become the pipeline's source. Afterwards the fragment's whole result is drained through an `ExchangeSender` built from `outputPartitioning`:

```typescript
if (sender && !cancelToken.cancelled) {
  for await (const chunk of sink) {
    await sender.consume(chunk);
  }
  await sender.finalize();
}
```

So the shape is: **`Exchange` is a planning marker, `ExchangeReceive` is the only exchange node that compiles to anything, and the sending side lives outside the plan entirely.** It also means a fragment does not stream — it fills a `ResultSink` completely, then sends.

## Running the fragments

[`_executeFragmentPlan`](../../src/distributed/execution/coordinator.ts) sorts fragments into dependency levels and dispatches a level at a time:

```typescript
for (const level of levels) {
  ...
  await Promise.all(level.map(f => this._dispatchFragment(f, fragmentPlan)));
}
```

[`_groupByDependencyLevel`](../../src/distributed/execution/coordinator.ts) computes the levels from the order [`topologicalOrder`](../../src/distributed/planner/fragment.ts) gives. The root fragment is excluded and run last, in-process, so the coordinator's own pipeline can pull from the receivers.

Each dispatch is retried up to `Config.fragmentRetryLimit` (3), on a different node when one is available:

```typescript
} catch (err) {
  fragment.markFailed(err);
  if (!fragment.canRetry(maxRetries)) {
    throw new Error(`Fragment ${fragment.fragmentId} failed after ${maxRetries} retries: ${err.message}`);
  }
  failedNodes.add(targetNodeId);
  fragment.state = FragmentState.PENDING;
}
```

A remote fragment is fire-and-forget over HTTP: the worker acknowledges with `202`, runs, and posts a `fragment_completed` control message back. The coordinator finds out by polling its own fragment object every 50 ms in [`_waitForFragmentCompletion`](../../src/distributed/execution/coordinator.ts) until `Config.coordinatorTimeoutMs` (five minutes) elapses.

## In the code

| Idea | Where |
|---|---|
| Which functions split, and how | [`DECOMPOSABLE_FUNCTIONS`](../../src/planner/aggregate-decomposition.ts) |
| The rewrite | [`PartialAggregatePass`](../../src/distributed/optimizer/partial-aggregate.ts) |
| Refusing `DISTINCT` | [`_canDecompose`](../../src/distributed/optimizer/partial-aggregate.ts) |
| `AVG`'s two-column partial | [`buildPartialAggregate`](../../src/execution/builders/aggregate-builder.ts) |
| `AVG`'s pair-consuming final | [`AvgFinalAccumulator`](../../src/execution/operators/hash-aggregate.ts) |
| The distributed-only gate | [`isDistributed`](../../src/distributed/distributed-types.ts) |
| Registering the passes | [`enableDistributed`](../../src/engine/query-engine.ts) |
| Where an operator may run | [`runsOnWorkers`](../../src/distributed/planner/operator-capability.ts) |
| Cutting the plan | [`_placeGathers`](../../src/distributed/planner/distributed-planner.ts) |
| The unit of dispatch | [`Fragment`](../../src/distributed/planner/fragment.ts) |
| Channel naming | [`fragmentOutputChannel`](../../src/distributed/planner/fragment.ts) |
| Running one fragment | [`FragmentExecutor`](../../src/distributed/execution/fragment-executor.ts) |
| Building one fragment's pipelines | [`executePlanInto`](../../src/distributed/execution/fragment-executor.ts) |
| Scheduling all of them | [`_executeFragmentPlan`](../../src/distributed/execution/coordinator.ts) |
| CTE flattening before planning | [`inlineCTEScans`](../../src/distributed/planner/cte-inline.ts) |

## Traps

**A fragment is not a thread.** Nothing in this chapter uses `SharedArrayBuffer`, morsels, or the pools from chapters 45 and 46. Fragments run in separate processes and communicate by copying bytes over HTTP. A worker process may internally use threads, and that is a completely independent decision.

**`Exchange` and `ExchangeReceive` are not a matched pair.** `ExchangeReceive` is generated by the distributed planner and compiles to a real source. `Exchange` is generated by the optimizer, is consumed by the planner, and compiles to nothing.

**`COUNT`'s final stage is `SUM`.** If you add a decomposable aggregate, the interesting question is not "can it be split" but "what is the intermediate type, and what function combines it".

**The coordinator plans with its own statistics.** In the CLI setup the coordinator loads only enough rows to infer a schema — 1,000 by default — so every cardinality estimate feeding these passes describes a sample, not the cluster. Chapter 48 shows a join strategy chosen on those numbers.

**CTEs are inlined before fragmentation.** [`inlineCTEScans`](../../src/distributed/planner/cte-inline.ts) expands every `CTEScan` into a copy of its definition, so a CTE referenced twice is planned, shipped, and computed twice. Non-recursive only; a self-reference is left alone.

## Recap

- Distribution is **six more optimizer passes**, added by `enableDistributed` with `registerPass` and `insertPassAfter`, each gated on a `_distributed` flag set on the plan root.
- `PartialAggregatePass` turns one `Aggregate` into `PartialAggregate → Exchange → FinalAggregate`, so only one row **per group** crosses the network.
- Decomposition can change the function: `COUNT` finalizes with `SUM`. It can also change the intermediate **type** — `AVG` becomes `AVG_PARTIAL`, which emits `_avg_sum` and `_avg_count`, and `AVG_FINAL`, which sums both and divides once.
- `DISTINCT` aggregates are not decomposable and are left whole.
- A **fragment** is a plan subtree plus a target node, a list of input fragments, and an output partitioning. `_placeGathers` cuts at exchange boundaries and replaces each pushed-down subtree with an `ExchangeReceive`.
- `Exchange` compiles to **nothing**; `FragmentExecutor` does the sending, from outside the plan, after the fragment has finished.

Next: [chapter 48](48-partitioning-and-pruning.md) asks the question this chapter dodged — which worker holds which rows — and finds a join that cannot run.
