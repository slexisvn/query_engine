# 35. Merge join, nested loop, and join semantics

> After this chapter you will be able to compare hash, merge, and nested loop joins, and check how each preserves the rows required by a join type.

## The question

A merge join walks two sorted inputs in lockstep. It needs sorted input, which is its whole premise. So it is the operator you choose when your data is already sorted.

Here is what this engine does with a `LEFT JOIN` over two unsorted tables of 40,000 and 160,000 rows:

```
Project
  MergeJoin(LEFT, build=right, sort=LR)
    TableScan
    TableScan
```

`sort=LR` means the operator must sort *both* inputs itself. The planner looked at a hash join, looked at sorting 200,000 rows and then merging them, and picked the sorts. Meanwhile the same query as an `INNER JOIN` on the same tables gets a hash join.

Both algorithms can implement the required semantics; the cheaper estimate is not proof of the faster runtime. The choice is made before operator execution. The choice comes from the cost model, which this chapter returns to once the operators are on the table — The planner may substitute algorithms only where each implements the required semantics. [`join-core.ts`](../../src/execution/operators/join-core.ts) provides a shared hash-join path; merge and nested loop also have their own emission code, so agreement needs testing.

## Three operators, one set of rules

SQL has more join types than most people use. This engine implements [nine](../02-logical-plan/11-the-logical-plan-nodes.md), and every one of them has to work identically under three different operators. The tempting way to get that wrong is to implement the semantics three times.

[`probeJoinInto`](../../src/execution/operators/join-core.ts) is the shared implementation — it takes an iterable of probe rows, a lookup function, and a set of options, and writes into a [`JoinOutputBuffer`](../../src/execution/operators/join-core.ts). The hash join calls it, and so do the parallel fragment workers of Part 6. One small predicate carries the padding rule:

```typescript
export function preservesProbe(joinType: JoinType): boolean {
  return joinType === JoinType.LEFT
    || joinType === JoinType.RIGHT
    || joinType === JoinType.FULL
    || joinType === JoinType.SINGLE;
}
```

`preservesProbe` means: a probe row with no match still produces output, padded with nulls. That is half of what an outer join needs.

The other half — build rows that nothing matched — is not decided here, because it depends on which side *became* the build, and `probeJoinInto` never sees the probe stream end. It is decided before execution by [`isBuildSidePreserved`](../../src/planner/join-build-side.ts):

```typescript
export function isBuildSidePreserved(joinType: JoinType, buildIsLeftChild: boolean): boolean {
  return joinType === JoinType.FULL || (joinType === JoinType.LEFT && buildIsLeftChild);
}
```

[`buildJoin`](../../src/execution/builders/join-builder.ts) calls it once and hands the answer to the operator as `buildPreserved`, which chapter 34 traced to the matched bitmaps. Note the asymmetry: a `LEFT` or `RIGHT` join gets its preserved side onto the *probe*, where `preservesProbe` already handles it, so on the hash-join path only `FULL` normally sets `buildPreserved`.

There is a third predicate in the file, [`emitsUnmatchedBuild`](../../src/execution/operators/join-core.ts), which reads like the join-type half of that rule. **Nothing in `src/` calls it** — only its unit test does. It is the shape the rule would take if the decision belonged to the join type alone, and it does not.

The other four types are not about padding but about *shape*, and [`outputColumnsOf`](../../src/execution/operators/join-core.ts) is where that shows:

```typescript
if (joinType === JoinType.SEMI || joinType === JoinType.ANTI) return probeColumns;
if (joinType === JoinType.MARK) {
  return [...probeColumns, { origin: ColumnOrigin.MARK, index: 0, dataType: 'BOOLEAN' }];
}
```

A `SEMI` or `ANTI` join emits **only the probe columns** — it is a filter, not a join, and the build side exists to answer a yes/no question. A `MARK` join emits the probe columns plus one boolean saying whether a match existed; that is how `IN` and `EXISTS` subqueries survive decorrelation, and the boolean is three-valued so that `x IN (SELECT ...)` with nulls behaves. `SINGLE` emits at most one build row per probe row, which is what a scalar subquery needs.

Here are five of them — the three that pad, plus the two that filter — running on four left rows and four right rows with a null on each side, under whichever operator the planner picked. `RIGHT` is `LEFT` with the inputs exchanged, `CROSS` pairs everything, and `MARK` and `SINGLE` are shown in [chapter 26](../03-optimizer/26-subquery-unnesting.md) where the subqueries that produce them are:

```
### INNER                          ### LEFT
{"NAME":"a","TAG":"x"}             {"NAME":"a","TAG":"x"}
{"NAME":"a","TAG":"y"}             {"NAME":"a","TAG":"y"}
                                   {"NAME":"b","TAG":null}
### SEMI                           {"NAME":"c","TAG":null}
{"NAME":"a"}                       {"NAME":"z","TAG":null}

### ANTI                           ### FULL
{"NAME":"b"}                       {"NAME":"a","TAG":"x"}
{"NAME":"c"}                       {"NAME":"a","TAG":"y"}
{"NAME":"z"}                       {"NAME":"b","TAG":null}
                                   {"NAME":"c","TAG":null}
                                   {"NAME":"z","TAG":null}
                                   {"NAME":null,"TAG":"q"}
                                   {"NAME":null,"TAG":"w"}
```

Row `z` has a null key. It appears in `LEFT`, in `FULL`, and in `ANTI`, and never in `INNER` or `SEMI` — because a null key matches nothing, and "matches nothing" is exactly what `LEFT` and `ANTI` are looking for. That single fact is why `probeJoinInto` handles null keys before it consults the hash table at all:

```typescript
if (key === null) {
  if (joinType === JoinType.ANTI) {
    output.push(null, pRow);
  } else if (joinType === JoinType.MARK) {
    output.push(null, pRow, null);
  } else if (preservesProbe(joinType)) {
    output.push(null, pRow);
  }
  continue;
}
```

Note the `MARK` case pushes `null` as the mark, not `false`. A null key means "unknown whether it matched", and that unknown has to reach the outer query.

## The output buffer

`probeJoinInto` never builds a chunk. It appends to three parallel arrays — build rows, probe rows, and marks — and [`JoinOutputBuffer.toChunk`](../../src/execution/operators/join-core.ts) turns a slice of them into columns on demand:

```typescript
*chunks(batchSize: number, allocator: Allocator = heapAllocator): Generator<DataChunk> {
  for (let offset = 0; offset < this.length; offset += batchSize) {
    yield this.toChunk(offset, Math.min(offset + batchSize, this.length), allocator);
  }
}
```

So output is emitted in `flushBatchSize` chunks regardless of how the input was chunked, and a join that explodes one probe chunk into fifty thousand rows still emits 2,048 at a time. A column's type can also be *inferred* when the layout did not declare one: [`columnDataType`](../../src/execution/operators/join-core.ts) scans the slice for the first non-null value and guesses from its JavaScript type.

## Nested loop join

[`NestedLoopJoinOperator`](../../src/execution/operators/nested-loop-join.ts) is the one that does not use `probeJoinInto`. It reimplements the type rules in a doubly nested loop, because it has no hash table and no key extraction — its condition may be any expression:

```typescript
for (let o = 0; o < outerRows.length; o++) {
  const oRow = outerRows[o];
  let matched = false;
  let sawUnknown = false;

  for (let i = 0; i < innerRows.length; i++) {
    const iRow = innerRows[i];
    const combined = this._combineRow(oRow, iRow);

    if (adapter) {
      adapter.setRow(combined);
      const holds = this.conditionEvaluator!(adapter.chunk, 0);
      if (holds === null || holds === undefined) {
        sawUnknown = true;
        continue;
      }
      if (!holds) continue;
    }
    ...
  }
```

The `adapter` is worth a look. The condition was compiled by [`compileExpression`](../../src/execution/expression-eval.ts), so it expects a chunk and a row index. `_createAdapter` fabricates a one-row pseudo-chunk over the combined row array, whose columns are closures reading a mutable variable — a shim that lets one compiled predicate serve both a columnar operator and a row-at-a-time one.

Both inputs are fully materialized before the loop starts. [`buildNestedLoopJoin`](../../src/execution/builders/join-builder.ts) calls [`registerBufferedChild`](../../src/execution/builders/builder-utils.ts) twice, which is why a nested loop join costs two extra pipelines where a hash join costs one, as [chapter 30](30-push-based-pipelines.md) showed. That materialization is why the planner refuses to consider it above `nestedLoopMaxRows`, 50,000 rows across both sides.

It is also the only operator that can evaluate a join condition with no equality in it at all:

```
### non-equi:  L.ID < R.RID
Project
  Sort
    NestedLoopJoin(INNER, build=left)
      TableScan
      TableScan
{"NAME":"a","TAG":"w"}
{"NAME":"b","TAG":"w"}
{"NAME":"c","TAG":"w"}
```

Above the size limit, a non-equi join is planned as a `HashJoin` anyway, priced as `hashBuildCost + blockNestedLoopJoinCost`. That is not a mistake either: with no equi-keys, every row hashes to the same empty key, the whole build side lands in one bucket, and the probe compares each probe row against all of it. The hash join *becomes* a block nested loop, which is why the cost model prices it as one.

## Merge join

[`MergeJoinOperator`](../../src/execution/operators/merge-join.ts) takes two sorted streams and advances the one whose key is smaller:

```typescript
while (build.current && probe.current) {
  const cmp = compareJoinKeys(build.current.key, probe.current.key);

  if (cmp < 0) {
    this.emitUnmatchedBuild(build.current);
    await build.advance();
  } else if (cmp > 0) {
    this.emitUnmatchedProbe(probe.current, this.unmatchedMark);
    await probe.advance();
  } else {
    const groupKey = build.current.key;
    const buildGroup = await collectGroup(build, groupKey, this.buildGroupScratch);
    const probeGroup = await collectGroup(probe, groupKey, this.probeGroupScratch);
    this.emitGroup(buildGroup, probeGroup);
  }

  yield* this.drain();
}
```

The equality branch is where the algorithm's real content lives. Equal keys can repeat on both sides, so the operator collects the full run of equal keys from each — a **peer group** — and emits their cross product. That is the only place either cursor can move more than one row at a time.

Nulls are handled by moving them out of the way first. [`mergeJoinSortKeys`](../../src/execution/operators/merge-join.ts) sorts nulls first, and `execute` drains every null-keyed row from each side before the main loop begins, emitting whatever the join type requires. After that the comparison never has to reason about nulls.

Sortedness is not assumed; it is checked. [`SortedRowCursor`](../../src/execution/operators/merge-join.ts) compares each row against the previous one and raises on a violation:

```typescript
private assertNonDescending(previous: JoinRow | null, next: JoinRow): void {
  if (previous === null || isNullJoinKey(previous.key)) return;
  if (isNullJoinKey(next.key)) return;
  if (compareJoinKeys(previous.key, next.key) <= 0) return;
  throw new Error(`Merge join received unsorted ${this.label} input`);
}
```

Getting the input sorted is [`registerSortedChild`](../../src/execution/builders/builder-utils.ts)'s job: it inserts a `SortOperator` between the child and the merge join, in its own pipeline, with its own spill store. So `sort=LR` in the plan text is two extra blocking pipelines. The merge join then reads from `sortOp.stream()`, which is an async generator, which is why the cursors are async and the operator is a generator rather than a function.

### Why it wins the `LEFT` join

The planner's arithmetic explains the opening surprise. For an `INNER` join, `chooseJoinBuildSide` puts the smaller side on the build, and the hash join's costs stay proportional to the two inputs. For a `LEFT` join the build side is forced — the left input must stream, so the *right* side builds — and both operators pay differently.

More importantly, `mergeJoinCost` includes a term for **rescanned tuples**: `rescannedTuples(leftCard, rightCard, outputCard)` is `max(0, output − max(left, right))`, an estimate of how many extra probe-side rows have to be revisited because of duplicate keys. When the output cardinality is close to the larger input — which a `LEFT` join on a near-unique key produces — that term is near zero, and two `sortCost`s over 40,000 and 160,000 rows come in under `hashBuildCost` plus `hashProbeCost` plus `joinOutputCost`. Change the estimated output and the answer flips.

Merge join is also chosen for the semi and anti joins that decorrelated `EXISTS` and `IN` subqueries produce:

```
### semi (EXISTS)                  ### IN subquery
Project                            Project
  MergeJoin(SEMI, build=right, sort=LR)  MergeJoin(SEMI, build=right, sort=LR)
    TableScan                          TableScan
    Project                            TableScan
      TableScan
```

## Dependent join

There is a fourth operator that is a join in name. [`DependentJoinOperator`](../../src/execution/operators/dependent-join.ts) runs the inner plan once per outer row, but the builder only admits supported **uncorrelated** forms. It is a limited fallback, not a general interpreter for correlation that the optimizer could not remove.

Its constructor is a table of three emitters:

```typescript
const EMITTERS: Partial<Record<SubqueryType, SubqueryEmitter>> = {
  [SubqueryType.EXISTS]: (outerRow, subRows) => (subRows.length > 0 ? outerRow : null),
  [SubqueryType.NOT_EXISTS]: (outerRow, subRows) => (subRows.length === 0 ? outerRow : null),
  [SubqueryType.SCALAR]: (outerRow, subRows) => [...outerRow, subRows.length > 0 ? subRows[0][0] : null],
};
```

Any other subquery type throws at construction. And [`buildDependentJoin`](../../src/execution/builders/cte-builders.ts) refuses outright if correlated columns survived, with a message saying that `SubqueryUnnesting` is required for correctness. That is a deliberate hard failure rather than a slow path — an assertion that chapter 27's decorrelation did its job. In the plans this engine actually produces, a scalar subquery becomes an ordinary `LEFT` join over an aggregate:

```
### scalar subquery
Project
  HashJoin(LEFT, build=right)
    TableScan
    Project
      HashAggregate
        TableScan
```

## In the code

| Idea | Where |
|---|---|
| Shared join semantics | [`probeJoinInto`](../../src/execution/operators/join-core.ts) |
| Which types pad the probe side | [`preservesProbe`](../../src/execution/operators/join-core.ts) |
| Whether unmatched build rows are emitted | [`isBuildSidePreserved`](../../src/planner/join-build-side.ts) |
| Output shape per join type | [`outputColumnsOf`](../../src/execution/operators/join-core.ts) |
| Rows to chunks | [`JoinOutputBuffer`](../../src/execution/operators/join-core.ts) |
| Columnar row to array | [`materializeRow`](../../src/execution/operators/join-core.ts) |
| Merge join | [`MergeJoinOperator`](../../src/execution/operators/merge-join.ts) |
| Peer-group collection | [`collectGroup`](../../src/execution/operators/merge-join.ts) |
| Sortedness assertion | [`SortedRowCursor`](../../src/execution/operators/merge-join.ts) |
| Nested loop join | [`NestedLoopJoinOperator`](../../src/execution/operators/nested-loop-join.ts) |
| Limited uncorrelated fallback | [`DependentJoinOperator`](../../src/execution/operators/dependent-join.ts) |
| Operator construction | [`buildJoin`](../../src/execution/builders/join-builder.ts) |

## Traps

**`MergeJoinOperator` does not use `probeJoinInto`.** It has its own `emitGroup`, `emitUnmatchedBuild`, and `emitUnmatchedProbe`, and so does the nested loop join. Of the three operators only the hash join uses the shared path — outside them, so do the parallel fragment workers. The semantics are therefore implemented three times and kept in agreement by tests, not by construction — which is worth knowing before you add a ninth join type.

**A `LEFT` merge join swaps its inputs back.** [`buildMergeJoin`](../../src/execution/builders/join-builder.ts) checks whether the physical build side matches the logical left child and, for `LEFT` and `RIGHT` joins, rebuilds the schema and mapping in the other order. A merge join's output column order is fixed by which side it walks, so the planner's `buildSide` choice cannot be honored blindly.

**The nested loop join returns a single chunk.** `execute` accumulates every output row and calls `_buildOutputChunk` once — no `flushBatchSize` batching. The row limit that keeps it out of large plans is also what keeps that from mattering.

**`CROSS` joins are planned as hash joins.** With no condition there are no keys, so a cross join is a hash join with one bucket, and the operator has no special case for it. The cost model defines [`crossJoinCost`](../../src/planner/cost-model.ts), but nothing calls it — a cross join is priced by the same rules as any keyless join.

## Exercises

### Understand

Sorted left keys are [1,2,2] and right keys are [2,2,3]. How many inner-join rows does the peer group for key 2 produce?

### Practice

1. **Observe.** Reproduce the five-join-type table on four rows a side, including the null keys. Then add `RIGHT` and `CROSS` to it, and change the null on the right side to a real value that matches nothing and see which outputs change.

2. **Observe.** Take the `LEFT` join that becomes a merge join and use `CostRecorder` to print both candidates' costs at 40,000 and 160,000 rows. Then find the output cardinality at which the hash join wins.

3. **Extend (optional).** Force the sortedness assertion to fire. Construct a `MergeJoinOperator` directly with an unsorted source and confirm the error message names the side.

4. **Extend (optional).** `NestedLoopJoinOperator` emits one chunk. Change it to emit in `flushBatchSize` batches. Measure whether that changes anything at 100 x 100, and explain the result.

5. **Extend (optional).** In an isolated optimizer configuration, omit `SubqueryUnnesting` and compare an uncorrelated `EXISTS` with a correlated one. Follow `buildDependentJoin`: the supported uncorrelated form can run; the correlated form must raise. See `tests/e2e/subquery-unnesting-differential.test.ts` for an existing test of this boundary.

### Hints and expected observations

Four: two left rows times two right rows. A merge join must collect or otherwise handle duplicate runs, not simply advance both cursors after one match.

## Recap

- Inside [`probeJoinInto`](../../src/execution/operators/join-core.ts), all nine join types are described by one predicate — [`preservesProbe`](../../src/execution/operators/join-core.ts) — plus an output-shape rule that makes `SEMI` and `ANTI` emit probe columns only and `MARK` add a three-valued boolean. `INNER` and `CROSS` need no case of their own; they are what the code does when no rule fires. Unmatched **build** rows are settled earlier, by [`isBuildSidePreserved`](../../src/planner/join-build-side.ts), because that answer depends on which side became the build.
- A `NULL` join key matches nothing, which is why null-keyed rows appear in `LEFT`, `FULL`, and `ANTI` output and never in `INNER` or `SEMI`.
- **Nested loop join** materializes both inputs, evaluates an arbitrary condition through a one-row adapter chunk, and is only offered below 50,000 combined rows.
- **Merge join** walks two sorted cursors, collects **peer groups** of equal keys, and emits their cross product. It asserts sortedness rather than assuming it, and inserts its own sorts when the inputs are not sorted.
- Sorting both sides can still beat a hash join — the engine picks a merge join for a `LEFT` join over two unsorted tables, because the merge cost has a near-zero rescan term when the key is nearly unique.
- A **dependent join** runs an inner plan per outer row and exists only for subqueries that decorrelation did not remove; it throws if correlated columns reach it.

Next: [chapter 36](36-aggregation.md) covers the four aggregation strategies the planner chooses between, and what happens when three of them run the same operator.
