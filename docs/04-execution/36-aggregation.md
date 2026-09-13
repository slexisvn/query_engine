# 36. Aggregation

> After this chapter you will be able to name the four aggregation strategies in an `EXPLAIN` plan, say which of them are actually different programs, and explain how a `SUM` gets split in half.

## The question

The physical planner chooses between four aggregate operators. Chapter 29 showed the running query getting `PerfectHashAggregate` on three rows and `HashAggregate` on 30,000, and a survey over one table gives all four names:

```
no GROUP BY                Project <- UngroupedAggregate <- TableScan
GROUP BY K (4 groups)      Project <- PerfectHashAggregate <- TableScan
GROUP BY BIG (20k)         Project <- HashAggregate <- TableScan
GROUP BY NAME (7 strings)  Project <- HashAggregate <- TableScan
```

Four names in the plan. Now look at how the executor dispatches them:

```typescript
const BUILDERS: Partial<Record<PhysicalNodeType, BuilderFn>> = {
  ...
  [PhysicalNodeType.HASH_AGGREGATE]: buildAggregate,
  [PhysicalNodeType.STREAM_AGGREGATE]: buildAggregate,
  [PhysicalNodeType.UNGROUPED_AGGREGATE]: buildAggregate,
  [PhysicalNodeType.PERFECT_HASH_AGGREGATE]: buildAggregate,
```

One builder, and inside it exactly one branch:

```typescript
if (physical.type === PhysicalNodeType.STREAM_AGGREGATE) {
```

**Three of the four plan names produce the same operator.** `PerfectHashAggregate` — the one the running query gets, and the one the cost model prices at half the alternative — is a `HashAggregateOperator`, identical in every respect to the `HashAggregate` it was preferred over. The name is a planning-time claim about the data, not a different program.

That is worth stating plainly before anything else, because a book that let you infer otherwise from the plan text would have taught you something false.

## An aggregate state you can calculate

For input `(Alice,100)`, `(Carol,300)`, `(Alice,250)`, a grouped SUM can keep a map from name to running total. After each row its state is `{Alice:100}`, then `{Alice:100, Carol:300}`, then `{Alice:350, Carol:300}`. Finalization emits one row per group. AVG needs more state: Alice's sum is 350 and non-null count is 2, so her average is 175. This hand-worked map describes the idea before the hash table, accumulator interfaces, and spill files.

## The one operator that is different

[`StreamAggregateOperator`](../../src/execution/operators/stream-aggregate.ts) is a genuinely different algorithm, and it is the one that gets chosen least often. It assumes the input arrives in group-key order and keeps exactly one group's accumulators alive:

```typescript
const key = this.extractGroupKey(chunk, rowIdx);

if (currentKey !== key) {
  if (accumulators !== null) {
    const row = [...groupValues!];
    for (let a = 0; a < accumulators.length; a++) {
      row.push(accumulators[a].result());
    }
    outputRows.push(row);
  }
  currentKey = key;
  groupValues = this.groupByExtractors.map((fn) => fn(chunk, rowIdx) as ColumnValue);
  accumulators = this.aggregateDefs.map((def) => def.createAccumulator());
}
```

When the key changes, the previous group is finished and emitted; a new set of accumulators replaces it. Memory is O(1) in the number of groups instead of O(groups), which is the entire point — a stream aggregate over a billion distinct keys uses the same memory as one over three.

Getting it chosen is harder than it looks. [`groupOrderAlreadyProvided`](../../src/execution/physical-planner.ts) compares the group keys against the child's annotated `_sortedBy`, and [`sortKeyMatches`](../../src/planner/sort-properties.ts) requires the column names to agree *and* the table aliases to agree or one of them to be empty. Two queries that differ only in a subquery alias:

```sql
SELECT BIG, SUM(V) FROM (SELECT BIG, V FROM T ORDER BY BIG LIMIT 40000) S GROUP BY BIG
SELECT BIG, SUM(V) FROM (SELECT BIG, V FROM T ORDER BY BIG LIMIT 40000) T GROUP BY BIG
```

```
Project                   Project
  HashAggregate             StreamAggregate
    Project                   Project
      Project                   Project
        TopN                      TopN
          TableScan                 TableScan
```

The sort order is annotated as `T.BIG`, because that is the alias under which the sort was performed. Aliasing the subquery `S` renames the group key to `S.BIG`, the two keys no longer match, and the engine sorts its groups for nothing. That is not a bug you would find by reading either file alone.

Note also that `StreamAggregateOperator.execute` takes an **array of chunks**, not a stream — [`buildAggregate`](../../src/execution/builders/aggregate-builder.ts) buffers its whole child with `registerBufferedChild` and hands the array over. The operator's constant-memory property is real; the pipeline around it is not exploiting it.

## The hash aggregate

Everything else runs [`HashAggregateOperator`](../../src/execution/operators/hash-aggregate.ts). Its state is a [`createKeyedHashTable`](../../src/execution/hash-table.ts) — the same open-addressed table the hash join uses — mapping a key tuple to an integer entry id, plus a parallel array of accumulator sets:

```typescript
_groupStateFor(values: readonly EvalValue[]): GroupState {
  const entry = this.groups.findOrInsert(values);
  let state = this.groupStates[entry];
  if (state === undefined) {
    state = { accumulators: this.aggregateDefs.map((def) => def.createAccumulator()) };
    this.groupStates[entry] = state;
  }
  return state;
}
```

[`consume`](../../src/execution/operators/hash-aggregate.ts) does not call that once per row directly. It transposes first — extracting every group-key value and every aggregate input into a per-column array, then looping over rows:

```typescript
const groupByVals: EvalValue[][] = new Array(groupByCount);
for (let g = 0; g < groupByCount; g++) {
  groupByVals[g] = new Array(size);
  const fn = this.groupByExtractors[g];
  for (let i = 0; i < size; i++) {
    const rowIdx = hasSv ? sv![i] : i;
    groupByVals[g][i] = fn(chunk, rowIdx);
  }
}
```

Two aggregates over the same expression share one extraction, tracked by `valueKey`, so `SUM(x), AVG(x), COUNT(x)` evaluates `x` once per row rather than three times.

An **accumulator** is four methods: `add`, `result`, `exportState`, and `mergeState`. The last two exist for spilling and for the partial/final split below. Eight are registered in `ACCUMULATORS`, and [`getAccumulatorFactory`](../../src/execution/operators/hash-aggregate.ts) wraps three of them when `DISTINCT` is present:

```typescript
const DISTINCT_SENSITIVE_AGGREGATES: ReadonlySet<string> = new Set(['COUNT', 'SUM', 'AVG']);
```

`COUNT(DISTINCT x)` becomes a [`DistinctAccumulator`](../../src/execution/operators/hash-aggregate.ts) holding a `Set` of every value it has seen and running the inner accumulator over that set when asked for a result. `MIN(DISTINCT x)` is `MIN(x)`, correctly, so it is not wrapped.

### Spilling

The budget is checked after every chunk, and it counts *groups*, not rows:

```typescript
this.memoryBudget.reset();
this.memoryBudget.admit(this.groups.size);
if (this.spillStore && this.memoryBudget.exceeded) {
  await this.spillResidentGroups();
}
```

That is the right quantity: a hash aggregate over a billion rows and four groups holds four groups. When it trips, [`spillResidentGroups`](../../src/execution/operators/hash-aggregate.ts) partitions the current groups by hash into `aggSpillPartitions` — sixteen — writes each partition to its own spill handle, and **clears the table entirely**. Consumption continues from empty, so the same key can be written to the same partition several times.

That is why every accumulator needs `exportState` and `mergeState` and not merely a value. A spilled `AVG` writes `{sum, count}`, because two half-computed averages cannot be averaged. [`partialGroupsToChunk`](../../src/execution/operators/aggregate-state-codec.ts) encodes each group as a JSON string in a single `DictionaryColumn` — with `bigint` values tagged so they survive the round trip — and [`finalizeSpilled`](../../src/execution/operators/hash-aggregate.ts) reads one partition at a time, merging duplicates back together:

```typescript
for (const partition of ordered) {
  this._resetGroups();
  for await (const spilled of spillStore.readChunks(this.partitionHandle(partition))) {
    this.absorbPartials(chunkToPartialGroups(spilled));
  }
  for (const chunk of this.emitResidentGroups()) chunks.push(chunk);
}
```

All rows with a given key hash to the same partition, so one partition's groups are complete once that partition has been read — the same argument that makes hash join partitioning work.

### The ungrouped case

With no `GROUP BY`, `groupByExtractors` is empty and every row goes into a single group keyed by the empty tuple. One detail is easy to miss and is required by SQL:

```typescript
if (groupCount === 0) {
  if (this.groupByExtractors.length === 0) {
    const cols = this.aggregateDefs.map((def) => {
      const col = new Column(def.resultType, 1);
      const acc = def.createAccumulator();
      col.set(0, acc.result());
      ...
```

`SELECT COUNT(*) FROM empty_table` must return one row containing zero, not zero rows. A grouped aggregate over no rows returns nothing. The difference is those five lines.

## Partial and final

The fifth and sixth aggregate node types are not chosen by the physical planner at all. They are produced by an optimizer pass, and they split one aggregate into two.

The idea: `SUM` is decomposable. Summing partial sums gives the same answer as summing everything, so a `SUM` can be computed close to the data and combined later. [`AggregatePushdown`](../../src/optimizer/passes/aggregate-pushdown.ts) uses that to push an aggregate *below a join* — computing per-key sums on the larger input before the join has multiplied its rows:

```
-> Project (O.O_CUSTKEY, SUM(O.O_TOTALPRICE))
  -> FinalAggregate
    -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
      -> Seq Scan on CUSTOMER as C
      -> PartialAggregate
        -> Seq Scan on ORDERS as O

Physical Plan:
Project
  FinalAggregate
    HashJoin(INNER, build=left, runtimeFilter)
      TableScan
      PartialAggregate
        TableScan
```

The pass fires only when the group keys and every aggregate input come from a single side of an inner join, and only when that side has at least `eagerAggregationMinRows` — 50,000 — rows. It then builds both plans and keeps the rewrite only if `totalPhysicalCost` says it is cheaper.

`AVG` is the interesting case, because it is *not* decomposable — an average of averages is wrong. [`buildPartialAggregate`](../../src/execution/builders/aggregate-builder.ts) handles it by emitting two columns instead of one:

```typescript
if (funcName === 'AVG_PARTIAL') {
  aggDefs.push({ name: 'SUM', resultType: DataType.FLOAT64, createAccumulator: getAccumulatorFactory('SUM'), extractValue: extract });
  aggDefs.push({ name: 'COUNT', resultType: DataType.FLOAT64, createAccumulator: getAccumulatorFactory('COUNT'), extractValue: extract });
  aggSchemaCols.push({ name: '_avg_sum', dataType: DataType.FLOAT64, tableAlias: '' });
  aggSchemaCols.push({ name: '_avg_count', dataType: DataType.FLOAT64, tableAlias: '' });
```

and [`buildFinalAggregate`](../../src/execution/builders/aggregate-builder.ts) reads them back as a pair into an [`AvgFinalAccumulator`](../../src/execution/operators/hash-aggregate.ts), which sums the sums and sums the counts and divides at the end. That two-column widening is why `partialWidth` exists and why the final aggregate has to track a separate `partialStarts` offset per aggregate.

Both operators are `HashAggregateOperator` again, with different accumulator sets. The same mechanism is what [Part 6](../README.md) uses to aggregate across workers: partial aggregates run on each fragment, an exchange redistributes by key, and a final aggregate combines. The single-node eager-aggregation case and the distributed case are the same two nodes.

## The vectorized aggregator

There is a fifth aggregate implementation, and it does not run in the single-node path at all. [`VectorGroupAggregator`](../../src/execution/operators/vector-aggregate.ts) replaces the hash table with a **dense array indexed by key**: for an integer key it allocates an `Int32Array` covering `[min, max]` and indexes into it directly; for a dictionary-encoded string key it builds a remap from dictionary id to slot once per chunk and then indexes with it.

[`createVectorAggregator`](../../src/execution/operators/vector-aggregate.ts) returns `null` unless there is exactly one group key of a supported type, every aggregate is a non-distinct function over one plain column, and every stage below is a filter. Its only caller is [`fragment-worker.ts`](../../src/parallel/fragment-worker.ts), so it runs inside a parallel worker or not at all. It is what `PerfectHashAggregate` describes — but the planner's choice of that node type and this operator's availability are not connected.

## In the code

| Idea | Where |
|---|---|
| Strategy choice | [`aggregateCandidates`](../../src/execution/physical-planner.ts) |
| The `PerfectHashAggregate` predicate | [`canUsePerfectHashAggregate`](../../src/planner/aggregate-strategy.ts) |
| One builder for four node types | [`buildAggregate`](../../src/execution/builders/aggregate-builder.ts) |
| The operator three of them use | [`HashAggregateOperator`](../../src/execution/operators/hash-aggregate.ts) |
| Constant-memory operator | [`StreamAggregateOperator`](../../src/execution/operators/stream-aggregate.ts) |
| Accumulator registry | [`getAccumulatorFactory`](../../src/execution/operators/hash-aggregate.ts) |
| `DISTINCT` wrapping | [`DistinctAccumulator`](../../src/execution/operators/hash-aggregate.ts) |
| Spill trigger and partitioning | [`spillResidentGroups`](../../src/execution/operators/hash-aggregate.ts) |
| Merging spilled partials | [`absorbPartials`](../../src/execution/operators/hash-aggregate.ts) |
| Partial state encoding | [`aggregate-state-codec.ts`](../../src/execution/operators/aggregate-state-codec.ts) |
| Splitting an aggregate in two | [`AggregatePushdown`](../../src/optimizer/passes/aggregate-pushdown.ts) |
| `AVG` as sum plus count | [`AvgFinalAccumulator`](../../src/execution/operators/hash-aggregate.ts) |
| Worker-only dense aggregator | [`VectorGroupAggregator`](../../src/execution/operators/vector-aggregate.ts) |
| WASM kernel selection | [`resolveWasmAggKernel`](../../src/execution/operators/agg-wasm.ts) |

## Traps

**`PerfectHashAggregate` and `UngroupedAggregate` are labels.** They select no code path in the executor. Reading a plan, treat them as statements about what the optimizer believed, not about what will run.

**The stream aggregate compares keys as text.** [`extractGroupKey`](../../src/execution/operators/stream-aggregate.ts) builds a string with `keyIdentityText` and compares strings, where the hash aggregate compares typed values through the hash table. Two keys that are equal but differently typed can therefore behave differently under the two operators.

**Spilling clears the group table but not the spilled set.** After `spillResidentGroups`, `spilledPartitions` remembers which handles have data, and `finalize` routes to `finalizeSpilled` if that set is non-empty — even if the last batch of groups would have fit. Once an aggregate has spilled, its whole result comes back through the partition loop.

**`_tryWasmUngrouped` is checked before every ungrouped chunk.** `consume` calls it whenever there is no `GROUP BY` and `globalDispatch.kernels` is non-empty, which remains empty until kernels are registered, for example by `await engine.enableWasm()`. Loading kernels and satisfying this operator's dispatch conditions are separate steps, as chapter 54 shows. When kernels *are* registered it bails out on the first column with nulls, a mismatched type, or a missing kernel — after having already resolved kernels for the earlier aggregates.

**`aggSpillPartitions` must be a power of two.** The partition index is `hash & (partitionCount - 1)`. Setting `QE_AGG_SPILL_PARTITIONS=10` silently uses a mask of 9 and files groups into a subset of handles.

## Exercises

### Understand

One partial AVG sees [10,20] and another sees [100]. Why is averaging their two averages wrong?

### Practice

1. **Observe.** Reproduce the four-strategy survey. Then change the `GROUP BY K` column to have five distinct values instead of four and rerun. Explain the new plan using `hasCompactDomain`.

2. **Observe.** Reproduce the alias experiment that flips `HashAggregate` to `StreamAggregate`. Then make it flip back by renaming only the subquery alias, and find the line in [`sort-properties.ts`](../../src/planner/sort-properties.ts) responsible.

3. **Observe.** Run `SELECT O_CUSTKEY, AVG(O_TOTALPRICE) FROM ORDERS GROUP BY O_CUSTKEY` with `QE_MEMORY_LIMIT_BYTES=65536` and without. Confirm the multiset of rows is identical, and explain why `AvgAccumulator.exportState` returns an object rather than a number.

4. **Extend (optional).** Trigger `PartialAggregate`/`FinalAggregate` by joining a 200,000-row table to a small one and grouping by a key from the large side. Then change the aggregate to `AVG` and explain the plan you get.

5. **Extend (optional).** `DISTINCT_SENSITIVE_AGGREGATES` contains three names. Add `MIN` to it, run `SELECT MIN(DISTINCT x)`, and confirm the answer does not change. Then say what it cost.

### Hints and expected observations

The average of 15 and 100 is 57.5, but the correct result is 130/3. Merge sum/count states (30,2) and (100,1), then divide once.

## Recap

- The planner names four aggregate strategies, but [`buildAggregate`](../../src/execution/builders/aggregate-builder.ts) branches on only one: `HashAggregate`, `PerfectHashAggregate`, and `UngroupedAggregate` all construct the same [`HashAggregateOperator`](../../src/execution/operators/hash-aggregate.ts).
- **`StreamAggregate`** is the real alternative — one group's accumulators at a time — and requires the child's sort order to match the group keys down to the table alias.
- The hash aggregate keys a hash table by group tuple and holds one **accumulator** per aggregate per group. Extraction is transposed per chunk, and repeated expressions are evaluated once.
- The memory budget counts **groups**, not rows. On overflow, groups are partitioned by hash, written out as encoded partial state, and the table is cleared; `finalize` then reads one partition at a time and merges.
- Every accumulator exposes `exportState`/`mergeState`, which is why `AVG` spills as a sum and a count rather than as an average.
- **`PartialAggregate`/`FinalAggregate`** come from [`AggregatePushdown`](../../src/optimizer/passes/aggregate-pushdown.ts), not the physical planner, and split a decomposable aggregate across a join. Part 6 reuses the identical pair across workers.

Next: [chapter 37](37-sorting-and-topn.md) looks at ordering — and at a query that gets slower when you ask it for fewer rows.
