# 38. Window functions and frames

> After this chapter you will be able to say why `RANK` and `ROW_NUMBER` disagree, why a running `SUM` can jump by more than one row's worth, and how a window function survives running out of memory when its whole premise is that it needs every row at once.

## The question

A running total over six sales rows, ordered by amount, with no `PARTITION BY`:

```sql
SELECT PERIOD, AMT, SUM(AMT) OVER (ORDER BY AMT) AS S FROM SALES ORDER BY AMT, PERIOD
```

```
PERIOD  AMT  S
4       50   50
1       100  250
2       100  250
2       200  650
3       200  650
1       300  950
```

The two rows with `AMT` 100 both show 250 — the running total *after* both of them. Neither shows 150. The same happens at 200: both rows show 650, and the total jumps from 250 to 650 in one step.

That is not a bug, and it is not this engine being unusual. It is what the default window frame means, and the default window frame is one constant in [`window-frame.ts`](../../src/execution/operators/window-frame.ts).

## Peer groups

```typescript
export const DEFAULT_FRAME: BoundWindowFrame = {
  mode: 'RANGE',
  start: { type: 'UNBOUNDED_PRECEDING', offset: null },
  end: { type: 'CURRENT_ROW', offset: null },
};
```

An `OVER (ORDER BY ...)` with no explicit frame gets `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, and in `RANGE` mode **"current row" means "the last row with the same `ORDER BY` value as the current row"**. Rows sharing an ordering value are *peers*, and a `RANGE` frame can only start or end at a peer-group boundary.

[`boundIndex`](../../src/execution/operators/window-frame.ts) is where the two modes diverge, and the difference is three lines:

```typescript
case 'CURRENT_ROW':
  if (mode === 'ROWS') return index;
  return isStart ? peers.first[index] : peers.last[index];
```

In `ROWS` mode, current row is this row. In `RANGE` mode, it is the first or last of this row's peer group. [`peerGroupsOf`](../../src/execution/operators/window-frame.ts) computes both arrays in one pass by walking until the peer test fails:

```typescript
export function peerGroupsOf(length: number, samePeer: (a: number, b: number) => boolean): PeerGroups {
  const first = new Int32Array(length);
  const last = new Int32Array(length);
  let groupStart = 0;
  for (let i = 1; i <= length; i++) {
    if (i < length && samePeer(i, i - 1)) continue;
    for (let j = groupStart; j < i; j++) {
      first[j] = groupStart;
      last[j] = i - 1;
    }
    groupStart = i;
  }
  return { first, last };
}
```

So both `AMT = 100` rows have `last = 2`, both frames end at position 2, and both sums include both hundreds. Write `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` instead and you get 150 and 250.

The same peer notion explains the ranking functions. On four East-region rows with two tied amounts:

```
REGION  PERIOD  AMT  RN  RK  DR
East    2       200  1   1   1
East    3       200  2   1   1
East    1       100  3   3   2
East    4       50   4   4   3
```

`ROW_NUMBER` counts positions. `RANK` restarts at the position of the peer group. `DENSE_RANK` counts peer groups. In [`computePlan`](../../src/execution/operators/window.ts) that is three short loops sharing one `samePeer` call:

```typescript
case RANK: {
  let rank = 1;
  for (let i = 0; i < partition.length; i++) {
    if (i > 0 && !samePeer(orderColumns, partition[i], partition[i - 1])) rank = i + 1;
    result[partition[i]] = rank;
  }
  break;
}
```

`i + 1` for `RANK`, `rank++` for `DENSE_RANK`, and that one character is the entire difference between the two functions.

## Frames as two index arrays

[`frameRangesOf`](../../src/execution/operators/window-frame.ts) turns a frame specification and a partition length into two `Int32Array`s — the start and end index of every row's frame — clamped to the partition:

```typescript
for (let i = 0; i < length; i++) {
  starts[i] = Math.max(0, boundIndex(frame.start, i, length, frame.mode, peers, true));
  ends[i] = Math.min(length - 1, boundIndex(frame.end, i, length, frame.mode, peers, false));
}
```

Every frame-based aggregate then works from those two arrays rather than from the frame syntax, which is what lets the same six aggregators serve every frame shape.

`SUM`, `AVG`, and `COUNT` are computed by **prefix sums**, so each row's frame costs two array reads no matter how wide the frame is (`COUNT(*)` needs no values at all — it subtracts the two frame indices):

```typescript
['SUM', (values, ranges) => {
  const prefix = prefixSumsOf(values);
  return values.map((_value, i) => {
    if (emptyFrame(ranges, i)) return null;
    const count = prefix.counts[ranges.ends[i] + 1] - prefix.counts[ranges.starts[i]];
    return count === 0 ? null : prefix.sums[ranges.ends[i] + 1] - prefix.sums[ranges.starts[i]];
  });
}],
```

[`prefixSumsOf`](../../src/execution/operators/window-frame.ts) accumulates a running sum *and* a running non-null count, which is what makes `SUM` over a frame of all nulls return `null` while `COUNT` over the same frame returns 0 — SQL requires both, and one prefix array cannot express it.

`MIN` and `MAX` cannot be done by prefix, because subtraction has no inverse for them. [`slidingExtreme`](../../src/execution/operators/window-frame.ts) uses a monotonic deque instead:

```typescript
for (let i = 0; i < length; i++) {
  const end = ranges.ends[i];
  while (filled <= end) {
    const value = values[filled];
    if (value !== null && value !== undefined) {
      while (deque.length > head && !keepLeft(values[deque[deque.length - 1]], value)) deque.pop();
      deque.push(filled);
    }
    filled++;
  }
  while (deque.length > head && deque[head] < ranges.starts[i]) head++;
  result[i] = ranges.starts[i] > end || deque.length === head ? null : values[deque[head]];
}
```

Each index is pushed once and popped once, so the whole column is O(n) regardless of frame width. The catch is in `filled` and `head`: both advance monotonically, so **this only works for frames whose starts and ends are non-decreasing**. Every frame the parser accepts has that property, and the deque would silently return wrong answers for one that did not.

Two frame forms are rejected rather than approximated:

```
### RANGE offset -> RANGE frames with PRECEDING offsets are not supported
```

`boundIndex` throws for `PRECEDING` or `FOLLOWING` outside `ROWS` mode, because a `RANGE` offset means "values within N of this row's value", which is a different search entirely from an index arithmetic. That is a real gap, stated in the error message.

## Partitioning, ordering, and sharing

[`WindowOperator`](../../src/execution/operators/window.ts) may have to evaluate several window expressions at once. [`buildGroups`](../../src/execution/operators/window.ts) groups them by [`partitionSignature`](../../src/execution/operators/window.ts) — a canonical string built from each `PARTITION BY` expression's `exprKey` — so window functions over the same partitioning share one partitioning pass. Within a group, [`columnFor`](../../src/execution/operators/window.ts) deduplicates the compiled expressions themselves, so `SUM(AMT) OVER w` and `MAX(AMT) OVER w` evaluate `AMT` once.

Evaluation is three phases. [`materializeEvals`](../../src/execution/operators/window.ts) walks the buffered chunks and produces one plain array per distinct input expression. [`partitionsOf`](../../src/execution/operators/window.ts) builds the partitions using the same [`createKeyedHashTable`](../../src/execution/hash-table.ts) the joins and aggregates use — collecting row indices, not rows:

```typescript
const table = createKeyedHashTable(keyColumns.length);
const groups: number[][] = [];
for (let i = 0; i < rowCount; i++) {
  for (let c = 0; c < keyColumns.length; c++) key[c] = columns[keyColumns[c]][i];
  const entry = table.findOrInsert(key);
  ...
  group.push(i);
}
```

With no `PARTITION BY` there is one partition containing every index, built without a hash table at all. Then `computePlan` sorts each partition by that window's own `ORDER BY` — [`sortedPartition`](../../src/execution/operators/window.ts), an ordinary comparator sort over indices — and writes results back into `result[partition[i]]`, at the row's *original* position. Output rows stay in input order; only the computation is reordered.

That per-plan sort is why two window functions with the same partitioning but different orderings still cost two sorts, and why the cost rule in [`plan-node-descriptor.ts`](../../src/planner/plan-node-descriptor.ts) sums a `sortCost` per window expression that has an `ORDER BY`.

## Running out of memory

A window function needs every row of a partition before it can produce any of that partition's output. So it buffers, and buffering is bounded:

```typescript
this.resident.push(flat);
this.memoryBudget.admit(flat.size);
if (this.memoryBudget.exceeded) await this.overflow();
```

[`overflow`](../../src/execution/operators/window.ts) is a one-way switch. Once it fires, `overflowed` stays true and every chunk — including the ones already buffered — goes to [`dispatch`](../../src/execution/operators/window.ts), which writes each chunk **twice**:

```typescript
await store.appendChunk(ROWS_RUN, chunk);

const baseOrdinal = this.dispatchedRows;
this.dispatchedRows += chunk.size;

for (let g = 0; g < this.groups.length; g++) {
  const routes = this.routeRows(chunk, this.groups[g]);
  const prefix = INPUT_RUN_PREFIX + g + RUN_SEPARATOR;
  for (let p = 0; p < routes.length; p++) {
    if (routes[p].length === 0) continue;
    await store.appendChunk(prefix + p, taggedChunk(chunk, routes[p], baseOrdinal));
  }
}
```

Once into `ROWS_RUN`, in arrival order, to reconstruct the output. And once per window group, hash-partitioned by the group's `PARTITION BY` key into `windowSpillPartitions` handles. The second copy is what makes the whole thing work: **all rows of a partition hash to the same spill handle**, so one handle can be read back on its own and computed exactly as if it were the entire input. That is the same argument as the hash join's partitions and the hash aggregate's, applied to a third operator.

[`taggedChunk`](../../src/execution/operators/window.ts) appends one extra column to each spilled chunk: the row's global ordinal. That is the thread that lets the results find their way home. [`spillGroupResults`](../../src/execution/operators/window.ts) reads one partition handle, computes the window functions over it, and writes the *results* back out — ordinal first, then one column per window plan. [`mergeByOrdinal`](../../src/execution/operators/window.ts) then merges the sixteen result handles with a [`PriorityQueue`](../../src/utils/priority-queue.ts) keyed on that ordinal, yielding one row of values at a time in original order, while `streamSpilled` walks `ROWS_RUN` and pairs each input row with the next merged result.

So the spilled path is: partition to disk, compute per partition, sort-merge the answers back into input order. Both paths call the same `computeGroup`, which is why an operator that spills produces the same values as one that does not.

## In the code

| Idea | Where |
|---|---|
| Window operator | [`WindowOperator`](../../src/execution/operators/window.ts) |
| Grouping windows by partitioning | [`buildGroups`](../../src/execution/operators/window.ts) |
| Building partitions | [`partitionsOf`](../../src/execution/operators/window.ts) |
| Per-window ordering | [`sortedPartition`](../../src/execution/operators/window.ts) |
| Ranking and offset functions | [`computePlan`](../../src/execution/operators/window.ts) |
| The default frame | [`DEFAULT_FRAME`](../../src/execution/operators/window-frame.ts) |
| Peer-group boundaries | [`peerGroupsOf`](../../src/execution/operators/window-frame.ts) |
| Frame bounds to indices | [`frameRangesOf`](../../src/execution/operators/window-frame.ts) |
| Prefix-sum aggregates | [`FRAME_AGGREGATORS`](../../src/execution/operators/window-frame.ts) |
| Sliding `MIN`/`MAX` | [`slidingExtreme`](../../src/execution/operators/window-frame.ts) |
| Spill routing | [`dispatch`](../../src/execution/operators/window.ts) |
| Ordinal tagging | [`taggedChunk`](../../src/execution/operators/window.ts) |
| Reassembling spilled results | [`mergeByOrdinal`](../../src/execution/operators/window.ts) |
| Pipeline wiring | [`buildWindow`](../../src/execution/builders/pipeline-builders.ts) |

## Traps

**`RANGE` is the default, not `ROWS`.** A running total written `SUM(x) OVER (ORDER BY d)` includes every row that ties on `d`. If your ordering key has duplicates and you wanted a strict running total, you have to write `ROWS` explicitly. This is standard SQL and catches everyone once.

**`LAG` and `LEAD` ignore the frame entirely.** They are handled in `computePlan`'s switch, not by a frame aggregator, and index directly into the sorted partition. `LAG(x, 1) OVER (ORDER BY d ROWS BETWEEN 5 PRECEDING AND CURRENT ROW)` gives the previous row regardless of the frame clause.

**The `LAG`/`LEAD` offset is read from the first row of each partition.** `Number(columns[plan.argColumns[OFFSET_ARG]][partition[0]])` evaluates the offset expression once per partition. A per-row offset expression is silently applied uniformly.

**A window function without `PARTITION BY` builds one partition of every row and sorts it.** There is no fast path for the whole-table case, and the memory cost is the whole table regardless.

**`windowSpillPartitions` must be a power of two.** As with the aggregate's partitions, routing uses `hash & (partitionCount - 1)`.

**Output columns are appended, not substituted.** [`buildWindow`](../../src/execution/builders/pipeline-builders.ts) names them `__window_0`, `__window_1`, and so on, and maps each window expression's `exprKey` to the new index — which is how a projection above finds the value through `materializedColumnOf`, the mechanism from [chapter 33](33-filters-and-expression-evaluation.md).

## Exercises

1. Reproduce the running-total table, then change `OVER (ORDER BY AMT)` to `OVER (ORDER BY AMT ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` and explain both outputs in terms of `peerGroupsOf`.

2. Write a query where `RANK` and `DENSE_RANK` differ by more than one, and predict both columns before you run it.

3. Run a window query with `QE_MEMORY_LIMIT_BYTES=65536` over enough rows to force `overflow`, and confirm the results are identical to the unspilled run — including row order, which the ordinal merge is supposed to preserve.

4. `slidingExtreme` assumes frame starts and ends never move backwards. Construct — on paper — a frame specification that would violate it, and say why the parser cannot produce one.

5. Add `RANGE` support for numeric `PRECEDING` offsets: instead of `index - offset`, binary-search the sorted partition for the first row whose value is at least `value - offset`. Where in `window-frame.ts` does that information have to arrive, and what does that tell you about the current signature of `boundIndex`?

## Recap

- The default frame is **`RANGE UNBOUNDED PRECEDING TO CURRENT ROW`**, and in `RANGE` mode "current row" means the last of the row's **peer group** — which is why tied rows share a running total.
- [`frameRangesOf`](../../src/execution/operators/window-frame.ts) reduces every frame to two index arrays, so the aggregators never see frame syntax.
- `SUM`, `AVG`, and `COUNT` are computed by **prefix sums** — constant time per row, and `COUNT(*)` by index arithmetic — while `MIN` and `MAX` use a **monotonic deque**, linear over the whole partition.
- `ROW_NUMBER`, `RANK`, and `DENSE_RANK` differ only in how they respond to peers; `LAG` and `LEAD` ignore the frame and index the sorted partition directly.
- Window expressions sharing a `PARTITION BY` are grouped so the partitioning pass and the input expressions are computed once.
- On overflow, every chunk is written twice — once in arrival order, once **hash-partitioned by partition key** — each spilled row carries a global **ordinal**, and results are merged back into input order with a priority queue.

Next: [chapter 39](39-memory-and-spilling.md) collects the memory budget that all of these operators share, and asks what "the same answer" means once spilling starts.
