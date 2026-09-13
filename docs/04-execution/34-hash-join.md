# 34. Hash join

> After this chapter you will be able to explain how this engine joins two tables that do not fit in memory, and why the hash function has to change every time it gives up and tries again.

## The question

Join 150,000 customers to 1,500,000 orders. The naive nested loop does 225 billion comparisons. The fix everyone reaches for is a hash map from customer key to customer row: build it once, then scan orders and look each one up. Two passes, 1.65 million operations instead of 225 billion.

First follow that lookup on the book's small dataset. Then we can ask what happens when the lookup structure is larger than memory.

## Build and probe, one row at a time

For this hand-worked **inner join**, push the segment filter onto the customers first. The build input is Alice (key 1) and Carol (key 3). Inserting them gives this conceptual lookup table:

| Join key | Stored customer rows |
|---:|---|
| 1 | Alice |
| 3 | Carol |

Now scan the orders. A **probe** asks whether the table contains that order's customer key:

| Order | Customer key | Lookup | Join output |
|---:|---:|---|---|
| 10 | 1 | Alice | Alice, 100 |
| 11 | 1 | Alice | Alice, 250 |
| 12 | 2 | no match | no row for this inner join |
| 13 | 3 | Carol | Carol, 300 |

The join emits three rows. It does not sum them; the aggregate above it later turns them into Alice 350 and Carol 300. The lookup is reused for every order instead of scanning every customer again. On such tiny inputs the physical planner may still prefer a nested loop; this trace demonstrates the hash algorithm, not the plan chosen for three customers.

A hash value chooses where to search; an equality check confirms the key. Two different keys can hash to the same location without matching. One key can also belong to several build rows, so a general join stores a list and emits every matching pair. The familiar `Map<key, row>` example works only when the build key is unique.

At larger sizes, partitioning and spilling preserve this build/probe idea while limiting how much of the lookup must be resident at once. The rest of the chapter follows that implementation in [hash-join.ts](../../src/execution/operators/hash-join.ts).

## Two operators, not one

This engine implements a hash join with two operators that run at different times:

- [`HashJoinBuild`](../../src/execution/operators/hash-join.ts) consumes every chunk of the build side and, when it has seen all of them, constructs the lookup structure.
- [`HashJoinProbe`](../../src/execution/operators/hash-join.ts) then streams the probe side through, emitting matches as it goes.

In this implementation the build side is **fully consumed before probing starts**. That requirement creates a pipeline dependency, as chapter 30 explains. Other hash-join designs can interleave work differently; here the build is blocking and the resident probe path is streaming.

### Which side builds

[`chooseJoinBuildSide`](../../src/planner/join-build-side.ts) picks, and it is short enough to quote whole:

```typescript
export function chooseJoinBuildSide(joinType, leftCardinality, rightCardinality) {
  if (PROBE_PRESERVING_JOINS.has(joinType)) return 'right';
  if (joinType === JoinType.RIGHT) return 'left';
  return rightCardinality < leftCardinality ? 'right' : 'left';
}
```

The last line prefers building from the **smaller** side to reduce memory and insertion work. The earlier branches reflect this engine's operator design: for `LEFT`, `SEMI`, `ANTI`, `MARK`, and `SINGLE`, the probe loop is driven by the left input, so the build is on the right. This is not the only possible implementation of those SQL semantics; preserving the build side instead would need additional matching and output bookkeeping.

Note that these cardinalities are *estimates*, produced by the optimizer from statistics. Choosing the build side is one of the places where a bad estimate turns into a slow query rather than a wrong one.

## Partitioning, before anything else

The naive build inserts every row into one hash table. This one does not. [`consume`](../../src/execution/operators/hash-join.ts) hashes each row's join key and files it into one of sixteen partitions:

```typescript
const keyHash = joinKeyHash(key, this.keyScratch);
const pIdx = partitionOf(keyHash);
const part = this.partitions[pIdx];

this.recordRuntimeFilterKey(keyHash);
part.rows.push({ row: chunkRows[i], key });

if (!part.spilled) {
  this.memoryBudget.admit(1);
}
```

Nothing has been hashed into a table yet. This is only bookkeeping — sixteen buckets of rows, sorted by hash. The count comes from `Config.hashJoinPartitions`, tunable through `QE_HASH_JOIN_PARTITIONS`.

Partitioning first makes spilling manageable. **Equal keys land in the same partition on both inputs**, so a build partition only needs to meet its corresponding probe partition. With a reasonably balanced key distribution, sixteen partitions are roughly one sixteenth of the data each. A frequent key can make one much larger; the repartitioning section below explains why hashing cannot split that key's rows.

## Running out of memory

[`RowMemoryBudget`](../../src/execution/memory-budget.ts) tracks how many rows are resident, using the schema's byte width to convert the configured memory limit into a row capacity. When it trips, the build picks the largest partition still in memory and evicts it to disk:

```typescript
if (this.memoryBudget.exceeded) {
  let maxPart = -1;
  let maxRows = 0;
  for (let i = 0; i < Config.hashJoinPartitions; i++) {
    if (!this.partitions[i].spilled && this.partitions[i].rows.length > maxRows) {
      maxRows = this.partitions[i].rows.length;
      maxPart = i;
    }
  }
  if (maxPart !== -1) {
    this.partitions[maxPart].spilled = true;
    this.memoryBudget.release(this.partitions[maxPart].rows.length);
    await this.flushPartition(maxPart);
  }
}
```

Marking a partition `spilled` is sticky. From then on, every further row destined for it goes straight through to disk in batches of `flushBatchSize`, and the probe side will treat it as a disk partition too. Evicting the largest partition frees the most memory per write, and the rest of the join carries on unchanged.

By the time [`finalize`](../../src/execution/operators/hash-join.ts) runs, some partitions are in memory and some are on disk. Only the resident ones get inserted into the actual hash table:

```typescript
if (!part.spilled) {
  this.trackMatches(i, part.rows.length);
  for (let r = 0; r < part.rows.length; r++) {
    const item = part.rows[r];
    const entry = this.hashTable.findOrInsert(joinKeyValues(item.key, this.keyScratch));
    ...
    bucket.push({ row: item.row, pIdx: i, rIdx: r });
  }
}
```

[`createKeyedHashTable`](../../src/execution/hash-table.ts) returns an open-addressed table mapping a key to an integer entry id; the rows themselves live in `buckets`, a parallel array of arrays, because a key can match many rows. Chapter 36 comes back to this structure, since aggregation uses the same one.

## Probing

For each probe row, [`process`](../../src/execution/operators/hash-join.ts) does four things in order.

**Extract the key.** If it is `NULL`, the row cannot match anything — SQL says `NULL = NULL` is unknown, not true — so it skips the hash entirely and goes to the in-memory list, where the join logic will decide whether it should still be emitted with `NULL` padding.

**Ask the runtime filter.** If this join is allowed to discard unmatched probe rows, and a Bloom filter says the key is definitely absent from the build side, the row is dropped on the spot:

```typescript
if (this.discardsUnmatchedProbeRows && !this.buildSide.probeMightMatchHash(keyHash)) {
  this.runtimeFilterRejections++;
  continue;
}
```

**Route it.** If its partition was spilled, the row is written to a probe-side spill file for that partition. Otherwise it joins the in-memory batch.

**Join the batch.** [`probeJoinInto`](../../src/execution/operators/join-core.ts) does the actual matching and output construction. It holds the per-join-type rules in one place, and chapter 35 shows both what those rules are and which operators actually share them.

### The runtime filter

The Bloom filter is built during the build phase — every key that goes into a partition also goes into [`BloomFilter`](../../src/utils/bloom-filter.ts) — and consulted during the probe. It answers "definitely not present" or "possibly present", never a false negative, at a configured 1% false-positive rate.

It is not always created. [`runtimeFilterEntries`](../../src/execution/physical-planner.ts) decides at planning time:

```typescript
const RUNTIME_FILTER_JOINS: ReadonlySet<JoinType> = new Set([JoinType.INNER, JoinType.SEMI]);

function runtimeFilterEntries(joinType, buildCardinality) {
  if (!RUNTIME_FILTER_JOINS.has(joinType)) return 0;
  if (buildCardinality < Config.joinRuntimeFilterMinRows) return 0;
  return Math.min(buildCardinality, Config.joinRuntimeFilterCapacity);
}
```

Two gates. **Only `INNER` and `SEMI`** — because only those two throw unmatched probe rows away. A `LEFT` join must emit a `NULL`-padded row for a probe row with no match, so discarding it early would delete output. The probe side asserts the same rule locally through `discardsUnmatchedProbeRows`, so the invariant holds even if the planner is wrong. **And only when the build side has at least 1,024 rows**, because below that the filter costs more to build than it saves.

The payoff is largest exactly when the join is hardest: a probe row rejected by the filter is never materialized into a row object and, if its partition was spilled, is never written to disk.

## The spilled partitions

After the probe stream ends, [`finalize`](../../src/execution/operators/hash-join.ts) still has work: every spilled partition pair has to be joined. It maintains a worklist:

```typescript
const pending = this.buildSide.spilledPartitionTasks();
while (pending.length > 0) {
  const task = pending.pop()!;
  if (this.shouldRepartition(task)) {
    for (const sub of await this.repartition(task)) pending.push(sub);
    continue;
  }
  await this.joinSpilledPartition(task, sink);
}
```

For each task, [`joinSpilledPartition`](../../src/execution/operators/hash-join.ts) reads that partition's build file back, fills the hash table with only those rows, streams the matching probe file through it, and clears the table again. One partition pair resident at a time.

### When a partition is still too big

`shouldRepartition` compares the partition's row count against the current memory budget. If a single partition still does not fit, it gets split into sixteen sub-partitions and the sub-tasks go back on the worklist. This recurses up to `hashJoinMaxRepartitionDepth`, four by default.

And here is the detail that makes it work at all:

```typescript
function partitionOf(keyHash: number, depth: number = 0): number {
  let h = keyHash ^ Math.imul(depth, REPARTITION_SEED_STEP);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) % Config.hashJoinPartitions;
}
```

The `depth` is mixed into the hash. **Without it, repartitioning would be a no-op**: every row in partition 7 is there precisely because its hash mod 16 was 7, so hashing them the same way again puts all of them back into one sub-partition, and the engine would spin uselessly until it hit the depth limit. Perturbing the seed at each level redistributes them.

The depth limit is the honest admission that this can fail. A partition dominated by a single key — a million orders belonging to one customer — cannot be split by any hash function, because the rows are genuinely identical from the join's point of view. After four attempts the engine stops trying and joins it anyway, accepting the memory spike. That is a real limitation, not a bug to be fixed by more recursion.

## Outer joins and the matched bitmap

Every outer join has to emit rows that nothing matched, and there are two ways to do it. When the preserved side is the *probe*, the padding happens inline as each probe row is processed, which is where chapter 35 picks the story up. When the preserved side is the *build*, the operator has to know — after the entire probe stream has finished — which build rows were never hit.

[`isBuildSidePreserved`](../../src/planner/join-build-side.ts) decides which case a join is in, before any data moves, and the answer reaches the operator as `buildPreserved`. It is true for `FULL`, and for `LEFT` when the build side is also the left child; because `chooseJoinBuildSide` sends every `LEFT` join's build to the right and every `RIGHT` join's build to the left, a hash join normally sets it only for `FULL`. That flag is what allocates the `matched` bitmaps:

```typescript
trackMatches(tag: number, rowCount: number): void {
  if (this.buildPreserved) this.matched[tag] = new Uint8Array(rowCount);
}
```

One byte per build row, allocated only when the build side is the preserved one. During probing, [`markMatched`](../../src/execution/operators/hash-join.ts) sets the byte for each build row that participated in a match; afterwards [`emitUnmatched`](../../src/execution/operators/hash-join.ts) walks the bitmaps and emits everything still zero — plus the `nullKeyRows` set aside at build time, which could never have matched and therefore are always unmatched.

The bitmaps are indexed per partition and released as soon as their partition is done, so a spilled join does not hold a bitmap for the entire build side at once.

## In the code

| Idea | Where |
|---|---|
| Build operator | [`HashJoinBuild`](../../src/execution/operators/hash-join.ts) |
| Probe operator | [`HashJoinProbe`](../../src/execution/operators/hash-join.ts) |
| Partition assignment | [`partitionOf`](../../src/execution/operators/hash-join.ts) |
| Spill trigger | [`RowMemoryBudget`](../../src/execution/memory-budget.ts) |
| Recursive repartitioning | [`repartition`](../../src/execution/operators/hash-join.ts) |
| Hash table | [`createKeyedHashTable`](../../src/execution/hash-table.ts) |
| Join semantics, shared | [`probeJoinInto`](../../src/execution/operators/join-core.ts) |
| Build-side choice | [`chooseJoinBuildSide`](../../src/planner/join-build-side.ts) |
| Whether unmatched build rows are emitted | [`isBuildSidePreserved`](../../src/planner/join-build-side.ts) |
| Runtime filter policy | [`runtimeFilterEntries`](../../src/execution/physical-planner.ts) |
| Bloom filter | [`BloomFilter`](../../src/utils/bloom-filter.ts) |
| Operator construction | [`src/execution/builders/join-builder.ts`](../../src/execution/builders/join-builder.ts) |

Relevant configuration, all overridable by environment variable in [`src/config.ts`](../../src/config.ts):

| Setting | Default | Effect |
|---|---|---|
| `hashJoinPartitions` | 16 | partitions per level |
| `hashJoinMaxRepartitionDepth` | 4 | how many times a partition may be re-split |
| `joinRuntimeFilterMinRows` | 1024 | build size below which no Bloom filter is made |
| `joinRuntimeFilterFalsePositiveRate` | 0.01 | filter sizing |
| `memoryLimitBytes` | 256 MB | drives the spill threshold |

## Traps

**Rows are materialized into arrays before being stored.** [`materializeRow`](../../src/execution/operators/join-core.ts) converts a position in a columnar chunk into a plain row array, because the hash table stores rows, not chunk offsets. This is the point where the engine's columnar layout is abandoned, and it is one of the more expensive things a join does — `costRowAssembly` in the cost model exists specifically to price it.

**A spilled partition is not a failure state.** Spilling is the design, not the fallback. A join that spills is expected to be slower, not incorrect, and the same code path runs whether spilling happens or not.

**The probe side's null keys still go into the in-memory list.** They cannot match, but for `LEFT` and `ANTI` joins they still produce output. Dropping them where the runtime filter drops rows would be wrong, which is why the null check comes first and returns early.

**`uniqueKeys` silently changes the build.** When the optimizer has proven the build key is unique, the build keeps only the first row per key and skips the rest of the bucket. If that proof is ever wrong, rows disappear from the result — this is a correctness dependency of the execution layer on the optimizer's [`unique-keys`](../../src/optimizer/unique-keys.ts) analysis.

## Exercises

### Understand

A build bucket contains two rows with key 7. One probe row also has key 7. How many rows does an inner equality join emit?

### Practice

1. **Observe.** Run a join and confirm the physical plan says `HashJoin`. Then shrink both tables to three rows and confirm it says `NestedLoopJoin`. Find the threshold in the cost model that flips it.

2. **Observe.** Force spilling: set `QE_MEMORY_LIMIT_BYTES` to something tiny (say 65536) and run a join over a few hundred thousand rows. Verify the result is identical to the unspilled run. This is the single most valuable test you can write against this operator.

3. **Extend (optional).** Instrument `runtimeFilterRejections` and print it after a join with a highly selective build side. What fraction of probe rows never reach the hash table?

4. **Extend (optional).** Delete the `depth` term from `partitionOf` so repartitioning uses the same hash at every level. Construct an input that spills, and observe what happens. Explain the behavior in terms of where the rows end up.

5. **Observe.** `chooseJoinBuildSide` returns `'right'` for `SEMI` joins regardless of size. Construct a semi join whose right side is a hundred times larger than its left, and reason about what that costs. Is the constraint avoidable?

### Hints and expected observations

Two, assuming no residual predicate rejects either pair. Hashing finds candidates; equality checks confirm matches and duplicate keys preserve multiplicity.

## Recap

- A hash join is a blocking **build** operator followed by a streaming **probe** operator. The build side is chosen by estimated size, unless join semantics force a side.
- The build **partitions rows by hash before building any table**. Same key, same partition, on both sides — so partition pairs can be joined independently.
- When the memory budget trips, the largest resident partition is **spilled** to disk and everything routed to it afterwards goes straight to disk.
- Spilled partition pairs are joined one at a time after the probe stream ends, and a partition that still does not fit is **recursively repartitioned** with a depth-perturbed hash — without which repartitioning would put every row back where it was.
- A **Bloom runtime filter** rejects probe rows that cannot match, but only for `INNER` and `SEMI` joins, because every other join type must still emit unmatched probe rows.
- `NULL` keys never match, but are retained separately because outer joins must still emit them.

Next: [chapter 35](35-other-joins.md) covers merge join and nested loop join, and the shared semantics layer that all three joins are built on.
