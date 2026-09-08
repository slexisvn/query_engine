# 37. Sorting and top-N

> After this chapter you will be able to explain why asking a query for ten rows can be nearly three times slower than asking it for four hundred thousand, and where the engine's two sorting algorithms hand over to each other.

## The question

One table, 400,000 integers, one `ORDER BY`. Four queries that differ only in their `LIMIT`:

```
query                                 | ms    | rows
ORDER BY V DESC LIMIT 10              | 285.4 | 10
ORDER BY V DESC LIMIT 1000            |  61.7 | 1000
ORDER BY V DESC LIMIT 100000          |  56.3 | 100000
ORDER BY V DESC                       | 103.2 | 400000
```

Asking for ten rows costs 285 ms. Asking for a hundred thousand costs 56. Asking for all four hundred thousand costs 103, less than half of what ten cost.

This is not measurement noise — it reproduces, and the whole curve falls out of two constants and one `if`. There is also a second surprise hiding in it: the plan for `LIMIT 10` says `TopN`, and there is no heap anywhere in the operator that runs it.

## One operator for both

`Sort` and `Top-N` are separate physical node types, but [`buildSort`](../../src/execution/builders/pipeline-builders.ts) and [`buildTopN`](../../src/execution/builders/pipeline-builders.ts) construct the same class with different arguments:

```typescript
const sortOp = new SortOperator(keyExtractors, node.limit ?? null, node.offset || 0, ...);   // buildSort
const sortOp = new SortOperator(keyExtractors, node.count, node.offset || 0, ...);           // buildTopN
```

[`SortOperator`](../../src/execution/operators/sort.ts) is a blocking operator in the sense of [chapter 30](30-push-based-pipelines.md): its `consume` accumulates and its `stream` produces, with a pipeline boundary between them. What it accumulates is worth noticing, because it is not chunks:

```typescript
appendChunk(chunk: DataChunk): void {
  const columnCount = this.columns.length;
  for (let i = 0; i < chunk.size; i++) {
    const rowIdx = chunk.activeRowIndex(i);
    for (let c = 0; c < columnCount; c++) {
      this.columns[c].push(chunk.columns[c]?.get(rowIdx) ?? null);
    }
    for (let k = 0; k < this.keyExtractors.length; k++) {
      this.keys[k].push(this.keyExtractors[k].eval(chunk, rowIdx) as ColumnValue);
    }
  }
  this.rowCount += chunk.size;
}
```

Every value is copied out of its typed array into a plain JavaScript array, one array per column plus one per sort key. The columnar layout is abandoned here, exactly as it is in a hash join's build. Sort keys are extracted once, on the way in, so a sort on `UPPER(name)` evaluates the expression once per row rather than once per comparison.

## Two sorting algorithms

[`sortedIndices`](../../src/execution/operators/sort.ts) never permutes the data. It produces an index permutation, and `gatherChunk` applies it when building output:

```typescript
if (keyCount === 1) {
  const key = this.keys[0];
  const { direction, nullsFirst } = this.keyExtractors[0];
  const radix = radixSortedIndices(key, this.rowCount, direction, nullsFirst);
  if (radix) return radix;
  order.sort((a, b) => compareOrderedValues(key[a], key[b], direction, nullsFirst) || a - b);
} else {
  order.sort((a, b) => { ... });
}
```

The comparison sort is `Array.prototype.sort` with a comparator, and it is the fallback for everything. [`compareOrderedValues`](../../src/execution/operators/sort.ts) handles direction and null placement in four lines, and `|| a - b` breaks ties by input position, which makes a single sort stable.

[`radixSortedIndices`](../../src/execution/operators/sort.ts) is the fast path, and it refuses far more often than it accepts:

```typescript
if (rowCount < Config.radixSortMinRows) return null;
...
if (typeof value !== 'number' || !Number.isInteger(value) || value < -INT32_BIAS || value >= INT32_BIAS) return null;
```

Four conditions, and all of them must hold for every row: at least `radixSortMinRows` rows (4,096), a single sort key, and every non-null value a `number` that is an integer inside the signed 32-bit range. One `1.5` anywhere in four hundred thousand rows sends the whole sort to the comparator.

When it accepts, values are biased into unsigned space, descending order is obtained by subtracting from `UINT32_MAX` rather than by reversing later, and nulls are pulled out into their own list and re-attached at whichever end `nullsFirst` says. Then [`radixPermute`](../../src/execution/operators/sort.ts) does two counting-sort passes of 16 bits each:

```typescript
for (let shift = 0; shift < 32; shift += RADIX_BITS) {
  counts.fill(0);
  for (let i = 0; i < count; i++) counts[(currentRanks[i] >>> shift) & RADIX_MASK]++;

  let total = 0;
  for (let bucket = 0; bucket < RADIX_BUCKETS; bucket++) {
    const bucketCount = counts[bucket];
    counts[bucket] = total;
    total += bucketCount;
  }
  ...
}
```

Two passes over the data and two passes over a 65,536-entry counting array. That is O(n) rather than O(n log n), and it shows:

```
rows    | INT32 (radix eligible) | FLOAT64 (comparison)
   2048 |                   3.2 |                  2.7
   4095 |                   5.2 |                  3.1
   4096 |                   3.5 |                  3.0
   8192 |                   3.5 |                  6.2
 262144 |                  26.2 |                270.2
1048576 |                  63.7 |               1122.0
```

The 4,095/4,096 pair is `radixSortMinRows` doing its job — one row apart, and the integer column switches algorithms. At a million rows the radix sort is 17 times faster. Below a few thousand the two are indistinguishable, which is why the threshold exists: the 65,536-entry counting array costs more to zero twice than a small comparison sort costs in total.

## Where the 285 ms went

Now the opening question. Top-N does not keep a heap of the best N rows. It keeps *everything*, and periodically throws away all but the best N:

```typescript
this.appendChunk(chunk);
this.memoryBudget.admit(chunk.size);

if (this.topN !== null && this.runCount === 0 && this.rowCount > this.topN * 4) {
  this.retain(this.sortedIndices().subarray(0, this.topN));
  this.memoryBudget.reset();
  this.memoryBudget.admit(this.rowCount);
}
```

`this.topN * 4` is the trigger, and `sortedIndices()` is a **full sort of everything resident**. Feed a `LIMIT 10` five hundred chunks of 2,048 rows and watch:

```
resident rows after 500 chunks (1,024,000 rows): 10
chunk 0: 0 + 2048 -> trimmed to 10
chunk 1: 10 + 2048 -> trimmed to 10
chunk 2: 10 + 2048 -> trimmed to 10
...
trim events: 500
```

Memory is bounded beautifully — ten rows after a million. But the threshold is 40 rows and a chunk is 2,048, so **every single chunk triggers a trim**, and every trim is a full sort of about 2,058 rows plus a `gather` of every column. Two thousand rows is below `radixSortMinRows`, so each of those sorts is a comparison sort.

That is the entire explanation of the table at the top:

| Query | `topN * 4` | What happens |
|---|---|---|
| `LIMIT 10` | 40 | trims after every chunk; ~196 comparison sorts of ~2,058 rows |
| `LIMIT 1000` | 4,000 | trims every other chunk; each sort is over ~5,000 rows, above the radix threshold |
| `LIMIT 100000` | 400,000 | `rowCount` never exceeds it, so no trim at all: one radix sort of 400,000 |
| no limit | — | one radix sort of 400,000, then 400,000 rows of output instead of 100,000 |

Small limits are pathological and large ones are not, which is the reverse of what anyone would guess from the SQL. The fix is not a heap — it is noticing that a trim only needs the N-th largest element, not a total order — but that is not what the code does today, and the plan node's name should not persuade you otherwise.

## Spilling and merging

The other exit from `consume` is the memory budget:

```typescript
if (this.memoryBudget.exceeded) {
  await this.spillCurrentRun();
}
```

[`spillCurrentRun`](../../src/execution/operators/sort.ts) sorts what is resident, truncates it to `topN` if there is one, writes it to a spill handle named `run_<n>`, and resets. Each spilled run is internally sorted; the runs are not sorted relative to each other. That is the classic external merge sort, and note that the top-N trim is disabled once `runCount > 0` — the guard is `this.runCount === 0` — because after spilling, "the best N seen so far" is no longer computable from what is resident.

[`stream`](../../src/execution/operators/sort.ts) then has two modes. With no runs it sorts once and emits in `flushBatchSize` slices. With runs it does a k-way merge, and *this* is where the engine's only [`PriorityQueue`](../../src/utils/priority-queue.ts) appears:

```typescript
const pq = new PriorityQueue<MergeCursor>((a, b) => {
  for (let k = 0; k < this.keyExtractors.length; k++) {
    const key = this.keyExtractors[k];
    const cmp = compareOrderedValues(
      states[a.runIndex].keys[k][a.rowIndex],
      states[b.runIndex].keys[k][b.rowIndex],
      key.direction,
      key.nullsFirst,
    );
    if (cmp !== 0) return cmp;
  }
  return a.runIndex - b.runIndex;
});
```

The heap holds one cursor per run — `{runIndex, rowIndex}` — so its size is the number of runs, not the number of rows. Pop the smallest, emit it, push the next cursor from that run. Ties break by run index, which keeps the merge deterministic.

`PriorityQueue` is a plain binary heap over an array, with `_compare(i, j)` returning `comparator(...) < 0`, so it is a min-heap under whatever ordering the comparator defines. Its only two callers in the engine are this merge and the window operator's ordinal merge in [chapter 38](38-window-functions.md) — a top-N heap is not among them.

`OFFSET` is applied during the merge by counting and discarding, and `topN` stops the loop early:

```typescript
if (this.topN !== null && count >= this.topN) break;
```

so a spilled `ORDER BY ... LIMIT 10` reads only as far into the runs as it needs to.

## `LIMIT` without `ORDER BY`

[`LimitOperator`](../../src/execution/operators/sort.ts) lives in the same file and shares nothing but the module. It is streaming, not blocking, and it never copies a row:

```typescript
if (startInChunk === 0 && count === chunk.size && !chunk.selectionVector) {
  this.chunks.push(chunk);
} else {
  const sv = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    sv[i] = chunk.activeRowIndex(startInChunk + i);
  }
  const result = new DataChunk(chunk.columns, count);
  result.setSelectionVector(sv, count);
  this.chunks.push(result);
}
```

A whole chunk within the window is kept by reference; a partial chunk gets a selection vector. Materialization happens once, in `takeChunks`, and only for the chunks that were narrowed. When `emitted >= limit` it sets `done`, which is what `buildLimit` turns into a cancel token — the mechanism [chapter 30](30-push-based-pipelines.md) traced.

## In the code

| Idea | Where |
|---|---|
| Sort and top-N operator | [`SortOperator`](../../src/execution/operators/sort.ts) |
| Copying rows out of chunks | [`appendChunk`](../../src/execution/operators/sort.ts) |
| Choosing an algorithm | [`sortedIndices`](../../src/execution/operators/sort.ts) |
| Radix eligibility | [`radixSortedIndices`](../../src/execution/operators/sort.ts) |
| Two 16-bit counting passes | [`radixPermute`](../../src/execution/operators/sort.ts) |
| Null placement and direction | [`compareOrderedValues`](../../src/execution/operators/sort.ts) |
| Default null order | [`nullsFirstFor`](../../src/execution/operators/sort.ts) |
| Spilling a sorted run | [`spillCurrentRun`](../../src/execution/operators/sort.ts) |
| k-way merge heap | [`PriorityQueue`](../../src/utils/priority-queue.ts) |
| `LIMIT` alone | [`LimitOperator`](../../src/execution/operators/sort.ts) |
| Sorting a join's input | [`registerSortedChild`](../../src/execution/builders/builder-utils.ts) |
| Thresholds | `radixSortMinRows`, `flushBatchSize` in [`config.ts`](../../src/config.ts) |

## Traps

**`Top-N` is a full sort with periodic truncation.** The plan node name promises a partial sort and the operator does not deliver one. Memory is bounded; time is not.

**Default null ordering depends on direction.** [`nullsFirstFor`](../../src/execution/operators/sort.ts) returns true for `DESC` and false for `ASC` unless `NULLS FIRST`/`NULLS LAST` was written explicitly. The effect is that a null behaves as though it were larger than every real value: it comes last under `ASC` and first under `DESC`. So reversing the direction *does* move the nulls, and a query that reads the first row of a `DESC` sort to get the maximum gets a null instead whenever the column has one.

**A single non-integer disqualifies the radix sort for the whole column.** `radixSortedIndices` scans every value before committing and returns `null` on the first violation. That scan is wasted work when it fails, and it fails on any `FLOAT64` column with a fractional value, on any string column, and on any `bigint`.

**Sorting is stable within one sort, not across a spill.** `|| a - b` breaks ties by input position, but the k-way merge breaks ties by run index. Two rows with equal keys can come back in either order once the sort has spilled — as [chapter 39](39-memory-and-spilling.md) shows with real output.

**The sort holds two copies of every key.** Keys are pushed into `this.keys` *and* their source values are pushed into `this.columns`, so a sort on a column that is also in the output stores it twice. That is a deliberate trade — no re-evaluation during comparison — but it doubles the resident footprint of the sort key.

## Exercises

1. Reproduce the limit sweep on 400,000 rows. Then set `QE_RADIX_SORT_MIN_ROWS=1` and rerun. Which row of the table changes most, and does the `LIMIT 10` case get faster or slower?

2. Instrument `SortOperator.consume` to count trims. Run `LIMIT 10` and `LIMIT 1000` over the same input and report both counts.

3. Change the trim threshold from `this.topN * 4` to `Math.max(this.topN * 4, 4 * DEFAULT_CHUNK_SIZE)` and rerun the sweep. Explain the new numbers, and say what you have given up.

4. Replace the top-N path with a bounded heap using `PriorityQueue`, keeping the largest N. Measure `LIMIT 10` before and after, and check that ties still come back in the same order — or explain why they do not have to.

5. Sort 100,000 rows on a `FLOAT64` column, then multiply every value by 1,000 and cast to integer and sort again. Report both times and confirm which path each took.

## Recap

- `Sort` and `Top-N` are the same operator with a different limit argument, and both copy every value out of the columnar layout into plain arrays on the way in.
- Sorting produces an **index permutation**; the data is gathered only when output chunks are built.
- Two algorithms: a **two-pass 16-bit radix sort** for a single integer key over at least `radixSortMinRows` rows, and `Array.prototype.sort` with a comparator for everything else. At a million rows the gap is 17x.
- **Top-N keeps every row and re-sorts whenever the buffer exceeds four times the limit**, so a small limit triggers a full sort per chunk. `LIMIT 10` over 400,000 rows is nearly three times slower than no limit at all.
- Exceeding the memory budget writes a sorted **run** to spill storage; `stream` then merges the runs with a [`PriorityQueue`](../../src/utils/priority-queue.ts) holding one cursor per run.
- `LIMIT` without `ORDER BY` is streaming, keeps whole chunks by reference, and cancels its input once satisfied.

Next: [chapter 38](38-window-functions.md) sorts within partitions rather than across a table, and computes over a moving frame.
