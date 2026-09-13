# 39. Memory budgets and spilling

> After this chapter you will be able to trigger supported spill paths, compare their results, and explain the limits of an operator's local memory estimate.

## The question

Run three queries against 30,000 customers and 120,000 orders, once with the default 256 MB budget and once with `QE_MEMORY_LIMIT_BYTES=65536`. Hash the results two ways — in the order returned, and after sorting the rows:

| Query | ordered hash | sorted hash |
|---|---|---|
| running query, `ORDER BY TOTAL DESC LIMIT 10` | `bf90961b` → `544efc7b` | `76504b7b` → `76504b7b` |
| the same, `ORDER BY TOTAL DESC, C_NAME LIMIT 10` | `e07ea22b` → `e07ea22b` | `e41e80cb` → `e41e80cb` |
| `GROUP BY O_CUSTKEY`, no `ORDER BY`, 30,000 rows | `ead36736` → `fc5edcd6` | `d754f056` → `d754f056` |

**The sorted hash never changes. The ordered hash changes twice.** Spilling did not lose a row, duplicate a row, or get an arithmetic result wrong in any of the three. What it changed is the order rows came back in — and only for the two queries whose `ORDER BY` does not determine one.

That is the correct guarantee, it is worth stating exactly, and it is the reason the second query is the useful regression test and the first is not.

## One budget, seven operators

Every spilling operator in the engine measures memory the same way, through [`RowMemoryBudget`](../../src/execution/memory-budget.ts). The class is under forty lines and holds three numbers:

```typescript
export class RowMemoryBudget {
  limitBytes: number;
  rowBytes: number;
  residentRows: number;
  ...
  get exceeded(): boolean {
    return this.residentBytes >= this.limitBytes;
  }
}
```

It counts **rows**, not bytes. Bytes are derived by multiplying a per-row width that the operator supplies once, from the schema:

```typescript
export function rowByteWidth(schema: readonly DataType[] | null | undefined): number {
  if (!schema || schema.length === 0) return Config.materializedRowOverheadBytes;

  let width = Config.materializedRowOverheadBytes;
  for (const dataType of schema) {
    width += isFixedWidth(dataType) ? byteWidthFor(dataType) : Config.variableWidthValueBytes;
  }
  return width;
}
```

Forty-eight bytes of per-row overhead, the declared width of each fixed-width column, and a flat 32 bytes for anything variable-width. It is an estimate, and deliberately so: real JavaScript heap usage per row cannot be measured from inside the program. The arithmetic is easy to see:

```
schema                                                | rowBytes | rowCapacity
no schema                                             |       48 |     5592405
INT32                                                 |       52 |     5162220
INT32, VARCHAR                                        |       84 |     3195660
C_CUSTKEY INT32, C_NAME VARCHAR, C_MKTSEGMENT VARCHAR |      116 |     2314098
9 x FLOAT64                                           |      120 |     2236962
```

At the 64 KB limit those capacities become 1,365, 1,260, 780, 564, and 546 — which is why a small `QE_MEMORY_LIMIT_BYTES` forces spilling with only a few thousand rows and makes the paths testable in a second rather than a minute.

Seven components construct one: the hash join — twice, once for the build and once inside [`shouldRepartition`](../../src/execution/operators/hash-join.ts) — plus the hash aggregate, the sort, the window operator, the chunk deduplicator, the result sink, and the parallel-join eligibility check in [`join-builder.ts`](../../src/execution/builders/join-builder.ts). Each calls `adoptSchema` when it sees its first chunk, `admit` as rows arrive, and reads `exceeded`.

There is no coordination between them. **Every operator gets the full `memoryLimitBytes` to itself**, so a plan with a hash join under a sort under a window may hold three times the configured limit and none of them will spill. The limit is a per-operator threshold, not a query-wide budget, and nothing in the engine reconciles the two.

## Two ways to count

The operators do not all admit the same thing, and the difference is the interesting part.

The **sort** and the **window operator** admit input rows: `this.memoryBudget.admit(chunk.size)`. What they hold is proportional to what they have read, so that is right.

The **hash aggregate** admits groups, and resets first:

```typescript
this.memoryBudget.reset();
this.memoryBudget.admit(this.groups.size);
```

`reset` then `admit` makes the count absolute rather than cumulative, which it has to be — a billion rows aggregating into four groups holds four groups.

The **hash join build** admits one row at a time and calls `release` when a partition is evicted, so the count tracks resident rows across a sequence of evictions rather than being recomputed.

The **chunk deduplicator** admits the rows it *emitted*, not the rows it saw, because those are the ones whose keys are in the hash set.

Getting this wrong in a new operator does not produce a wrong answer — it produces an operator that spills constantly or never spills at all.

## What spilling writes to

[`ChunkSpillStore`](../../src/storage/spill-manager/spill-manager.ts) is four methods:

```typescript
export interface ChunkSpillStore {
  appendChunk(partitionId: string, chunk: DataChunk | null): Promise<void>;
  readChunks(partitionId: string): AsyncGenerator<DataChunk>;
  clearPartition(partitionId: string): Promise<void>;
  clearAll(): Promise<void>;
}
```

A `partitionId` is a string an operator makes up — `run_0` for a sort run, `agg_7` for an aggregate partition, `window_in_0_3` for a window group's third partition — and each is an independent append-only byte stream.

[`SpillManager`](../../src/storage/spill-manager/spill-manager.ts) implements it by framing each chunk with a four-byte length and handing the bytes to a [`SpillStorage`](../../src/storage/spill-manager/spill-manager.ts):

```typescript
async appendChunk(partitionId: string, chunk: DataChunk | null): Promise<void> {
  if (!chunk || chunk.size === 0) return;
  const data = ChunkSerializer.serialize(chunk);
  const writer = new ByteWriter(new Uint8Array(LENGTH_HEADER_BYTES + data.length));
  writer.u32(data.length);
  writer.bytes(data);
  await this.storage.append(partitionId, writer.buffer);
}
```

That split separates the two layers' responsibilities. `SpillManager` knows about chunks and framing; `SpillStorage` knows about bytes. [`FsStorage`](../../src/storage/spill-manager/fs-storage.ts) appends to a file per partition, caching a write handle and closing it before opening a reader; [`MemoryStorage`](../../src/storage/spill-manager/memory-storage.ts) keeps a list of `Uint8Array`s per partition.

Which one you get depends on the entry point, and this is worth being precise about. [`ExecutionResources`](../../src/execution/execution-resources.ts) defaults to `new MemoryStorageBackend()`. `src/index.ts` installs [`NodeStorageBackend`](../../src/storage/backend/node-storage-backend.ts) as the default factory, and `src/browser.ts` installs the memory one. So **spilling in the browser build, and in any embedding that does not supply a backend, serializes chunks into memory buffers** — the row arrays and hash tables really are released, and the encoded bytes really are more compact, but nothing reaches a disk. Chapter 44 covers that injection.

## The three shapes of spilling

Every spilling operator in Part 4 uses one of three patterns, and they are worth naming because the fourth operator you write will be one of them.

**Partition by key hash, process one partition at a time.** The hash join ([chapter 34](34-hash-join.md)), the hash aggregate ([chapter 36](36-aggregation.md)), the window operator ([chapter 38](38-window-functions.md)), and the deduplicator all do this. It works because a key's rows all land in one partition, so a partition can be processed as if it were the whole input. This is the only pattern that handles operators whose output depends on seeing every row for a key.

**Write sorted runs, merge them.** The sort ([chapter 37](37-sorting-and-topn.md)) does this. Each spilled run is internally ordered; a k-way merge restores a total order without any run ever being resident in full.

**Write everything, read it back in order.** [`ResultSink`](../../src/execution/result-sink.ts) does this, because it has no processing left to do:

```typescript
async collectChunk(chunk: DataChunk): Promise<void> {
  if (this._collected.length === 0) {
    this._memoryBudget.adoptSchema(chunk.columns.map((column) => column.dataType));
  }
  this._collected.push(chunk);
  this._memoryBudget.admit(chunk.size);

  if (this._spillStore && this._memoryBudget.exceeded) {
    await this.spillCollected(this._spillStore);
  }
}
```

`materializedIterator` then yields the spilled chunks first and the still-resident ones second, and clears the store. So a non-streaming query whose *result* is larger than the budget still completes — a detail easy to overlook, since the result sink is the one "operator" that never appears in a plan.

### A worked example: the deduplicator

[`ChunkDeduplicator`](../../src/execution/operators/chunk-deduplicator.ts) backs both `DISTINCT` and `UNION`, and it shows the partitioning pattern applied to an operator whose in-memory state is a `Set<string>` rather than a hash table.

While resident, it keeps a key per distinct row and filters with a selection vector, copying nothing. When [`overflow`](../../src/execution/operators/chunk-deduplicator.ts) fires it flushes the rows it has already emitted to a handle, partitions **the key set itself** by hash, writes each partition out, and clears the set:

```typescript
const mask = this.partitionCount - 1;
const keyPartitions: string[][] = Array.from({ length: this.partitionCount }, () => []);
for (const key of this.seen) keyPartitions[hashValue(key) & mask].push(key);
for (let p = 0; p < keyPartitions.length; p++) {
  if (keyPartitions[p].length === 0) continue;
  await store.appendChunk(KEY_PARTITION_PREFIX + p, keysToChunk(keyPartitions[p]));
}
this.seen.clear();
```

From then on it emits nothing at all — every incoming chunk is routed by row-key hash into a row partition and returned as empty. [`drain`](../../src/execution/operators/chunk-deduplicator.ts) reassembles: for each partition, load that partition's keys back into `seen`, then filter that partition's rows against them. A row and the earlier row it duplicates hash identically, so they meet.

That is also where the row order changes. The already-emitted rows come out first, then partition 0's survivors, then partition 1's — which is nothing like arrival order. `DISTINCT` never promised one.

## What is preserved and what is not

The measurements at the top of this chapter are worth restating as three rules.

**Preserved: the multiset of result rows, and every value in them.** All three sorted hashes were identical. Aggregates spill as `exportState`/`mergeState` pairs precisely so this holds — an `AVG` writes a sum and a count rather than a quotient.

**Preserved: order, when the query specifies a total one.** `ORDER BY TOTAL DESC, C_NAME` gave byte-identical output both ways. So did a window query over 60,000 rows forced to spill: the ordinal-tagging scheme of chapter 38 reproduces input order exactly.

**Not preserved: order the query left unspecified.** `ORDER BY TOTAL DESC` alone has ten rows sharing three distinct totals, and the tie order moved. A `GROUP BY` with no `ORDER BY` came back in a completely different order, because the spilled aggregate emits partition by partition rather than in first-seen order. Neither is a bug — SQL does not order what you did not order — but it means an equality assertion on a row array is the wrong regression test, and the sorted comparison is the right one.

## In the code

| Idea | Where |
|---|---|
| The budget | [`RowMemoryBudget`](../../src/execution/memory-budget.ts) |
| Row width estimate | [`rowByteWidth`](../../src/execution/memory-budget.ts) |
| Spill store interface | [`ChunkSpillStore`](../../src/storage/spill-manager/spill-manager.ts) |
| Framing and serialization | [`SpillManager`](../../src/storage/spill-manager/spill-manager.ts) |
| Files on disk | [`FsStorage`](../../src/storage/spill-manager/fs-storage.ts) |
| Buffers in memory | [`MemoryStorage`](../../src/storage/spill-manager/memory-storage.ts) |
| Backend selection | [`NodeStorageBackend`](../../src/storage/backend/node-storage-backend.ts) |
| `DISTINCT` and `UNION` state | [`ChunkDeduplicator`](../../src/execution/operators/chunk-deduplicator.ts) |
| Spilling the result itself | [`ResultSink`](../../src/execution/result-sink.ts) |
| Spill directory allocation | `resources.tempManager.allocate`, in [`execution-context.ts`](../../src/execution/execution-context.ts) and the builders |

The relevant settings, all in [`config.ts`](../../src/config.ts):

| Setting | Default | Effect |
|---|---|---|
| `memoryLimitBytes` | 256 MB | the per-operator threshold |
| `materializedRowOverheadBytes` | 48 | fixed per-row cost in the estimate |
| `variableWidthValueBytes` | 32 | assumed size of a string or other variable value |
| `aggSpillPartitions` | 16 | hash aggregate partitions |
| `dedupSpillPartitions` | 16 | deduplicator partitions |
| `windowSpillPartitions` | 16 | window operator partitions |
| `hashJoinPartitions` | 16 | hash join partitions |
| `flushBatchSize` | 2048 | rows per spilled chunk |

## Traps

**The limit is per operator, not per query.** Three spilling operators in one plan can hold three times `memoryLimitBytes` between them and none will trip. Setting the limit to the machine's memory is therefore not safe.

**`rowByteWidth` is an estimate that ignores actual string length.** Every variable-width value counts as 32 bytes. A table of long text columns will overrun the real limit by a wide margin before the budget notices; a table of short strings will spill earlier than it needed to.

**Spilling is one-way for most operators.** `ChunkDeduplicator.overflowed` and `WindowOperator.overflowed` are sticky flags, and `HashAggregateOperator` routes through `finalizeSpilled` whenever `spilledPartitions` is non-empty. An operator that spills once behaves as a spilling operator for the rest of the query, even if the pressure was momentary.

**Every partition count is used as a bitmask.** `hash & (partitionCount - 1)` appears in the aggregate, the deduplicator, and the window operator. A non-power-of-two setting does not error; it quietly uses fewer partitions than requested.

**"Spilled to disk" is backend-dependent.** With the default `MemoryStorageBackend`, or in the browser build, the bytes stay in memory. The operator's *row objects* and *hash tables* are genuinely released, and the serialized form is far more compact, but a spilling query in that configuration is not bounded by anything except the sum of its serialized partitions.

**`clearAll` deletes everything the store holds, not one partition**, and [`SortOperator.stream`](../../src/execution/operators/sort.ts) calls it even on the non-spilled path. Two operators sharing a spill store would erase each other, which is why every builder allocates a fresh handle.

## Exercises

### Understand

If three operators each have a 64 KiB local budget, does that cap the whole query at 64 KiB?

### Practice

1. **Observe.** The central experiment of this part. Pick a query with a total `ORDER BY`, run it with the default budget and with `QE_MEMORY_LIMIT_BYTES=65536`, and assert the two row arrays are identical. Then remove the tie-breaking column and see whether peer order changes. A difference is permitted, not guaranteed. Without `LIMIT`, compare bags and verify sortedness; if a limit cuts a peer group, use a tie-aware check or restore a unique tie-breaker.

2. **Extend (optional).** Instrument `RowMemoryBudget.exceeded` to log the operator that asked. Run the running query at 30,000 customers with the small limit and report which operators spilled and in what order.

3. **Observe.** Compute by hand the `rowCapacity` for a five-column row of `INT32, FLOAT64, VARCHAR, VARCHAR, DATE` at a 1 MB limit, then check it with `rowByteWidth`.

4. **Extend (optional).** Set `QE_DEDUP_SPILL_PARTITIONS=10` and run a spilling `SELECT DISTINCT`. Confirm the answer is still correct, then explain — from the masking expression — why it is correct and what was wasted.

5. **Extend (optional).** Give `RowMemoryBudget` a shared parent so that all operators in one query draw from a single pool. Run the running query with a small limit before and after. Report what changed, and whether any answer did.

### Hints and expected observations

No. Their local budgets can sum to 192 KiB, with additional allocations outside those estimates. A spill to an in-memory backend also retains serialized bytes in the process.

## Recap

- [`RowMemoryBudget`](../../src/execution/memory-budget.ts) counts **rows** and converts to bytes with an estimated per-row width — 48 bytes of overhead plus each column's declared width, with variable-width values counted as a flat 32.
- Every spilling operator has **its own** budget with the full `memoryLimitBytes`. There is no query-wide pool.
- Operators admit different quantities — input rows for a sort, groups for an aggregate, emitted rows for the deduplicator — and choosing the wrong one makes an operator spill always or never.
- [`SpillManager`](../../src/storage/spill-manager/spill-manager.ts) frames serialized chunks into named byte streams; [`SpillStorage`](../../src/storage/spill-manager/spill-manager.ts) decides whether those bytes reach a file or a buffer, and the browser build gets buffers.
- Three patterns cover every case: **partition by key hash**, **write sorted runs and merge**, and **write everything and read it back**.
- Spilling preserves the **multiset of rows and their values**, and preserves order when the query specifies a total one. It does not preserve order the query left unspecified — which makes the sorted comparison the right regression test.

That completes Part 4. Next: Part 5 opens the storage layer these operators have been reading from and spilling into, starting with [columnar tables](../05-storage/40-columnar-tables.md).
