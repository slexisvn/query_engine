# 46. Workers and shared memory

> After this chapter you will be able to say what enabling worker threads costs before a single row is read, how a columnar chunk crosses a thread boundary without being serialized, and why the shipped CLI cannot enable threads at all.

## The question

Start the CLI with threads turned on and read the first two lines it prints:

```
[wasm] WebAssembly acceleration enabled
[parallel] Could not enable parallel execution (WASM required)
```

WebAssembly is enabled. The next line says parallel execution is impossible because WebAssembly is not. Both lines are printed by the same process, three statements apart.

[Chapter 2](../00-orientation/02-running-it-yourself.md) warned you about this and gave the workaround. Here is the diagnosis.

`.status` agrees with the second line:

```
  wasm:        enabled
  parallel:    disabled
  distributed: disabled
  mode:        local
```

The message is wrong, and why it is wrong tells you most of how the worker pools are wired.

## One `catch` and one `__dirname`

[`enableParallel`](../../src/engine/query-engine.ts) wraps its entire body in a `try`, and the `catch` discards the error:

```typescript
} catch (_) {
  this.parallelEnabled = false;
  return false;
}
```

The caller sees `false` and prints its own guess at the cause. Restore the error and it says:

```
[probe] enableParallel error: Cannot find module '...\dist\worker-thread.js'
```

[`WorkerPool`](../../src/parallel/worker-pool.ts) computes its worker entry point from its own module URL:

```typescript
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, 'worker-thread.js');
```

That is right for the per-file TypeScript output, where `dist/parallel/worker-pool.js` sits beside `dist/parallel/worker-thread.js`. It is wrong for the esbuild bundle, where `src/parallel/worker-pool.ts` has been inlined into `dist/index.node.js` and `import.meta.url` points at `dist/`. There is no `dist/worker-thread.js`. [`FragmentPool`](../../src/parallel/fragment-pool.ts) resolves `new URL('./fragment-worker.js', import.meta.url)` into the same empty directory, and [`src/cli/index.ts`](../../src/cli/index.ts) resolves `worker.js` the same way for distributed workers.

Run the same CLI from the per-file build and everything works:

```
[wasm] WebAssembly acceleration enabled
[parallel] Parallel execution enabled (11 workers)
...
  parallel:    enabled (11 workers)
```

So `npm start -- --parallel` and `npm start -- --distributed` are both inert on the published bundle, and every measurement in this part of the book was taken against `dist/` as `tsc` emits it. It is the first thing to check when a thread you expected does not appear.

## Two pools, not one

Enabling parallelism starts **two** independent sets of worker threads with different scripts, different message protocols, and different jobs.

| | `WorkerPool` | `FragmentPool` |
|---|---|---|
| Script | [`worker-thread.ts`](../../src/parallel/worker-thread.ts) | [`fragment-worker.ts`](../../src/parallel/fragment-worker.ts) |
| Unit of work | one column slice, one WebAssembly kernel | one plan fragment over a morsel of chunks |
| Data sharing | shared `WebAssembly.Memory` | `SharedArrayBuffer` arenas |
| Driven by | [`ParallelDispatch`](../../src/parallel/parallel-dispatch.ts) | the aggregate and join builders |
| Tasks received in practice | none | all of them |

[Chapter 45](45-morsel-driven-parallelism.md) showed why the first column is empty: `ParallelDispatch` is asked whether it can parallelize one chunk at a time and needs 10,000 rows to say yes. The pool is still constructed, still spawns threads, and still reserves memory for them.

How much memory. [`_spawnWorker`](../../src/parallel/worker-pool.ts) gives every worker a private region carved out of the one shared `WebAssembly.Memory`:

```typescript
const regionId = this.regionAllocator.addRegion();
const bounds = this.regionAllocator.getRegionBounds(regionId);
```

Each region is `Config.regionSize`, 16 MiB by default. Measured:

```
shared memory? true
bytes after enableWasm  : 16777216
regionSize: 16777216 workers: 11
bytes after enableParallel: 184549376 (= 176 MiB)
regions: 11 bounds of region 1: {"start":16777216,"end":33554432}
```

176 MiB of shared WebAssembly memory, allocated up front, for a pool that will not be sent a task. The private regions are the point: a worker bump-allocates inside its own `[start, end)`, so two threads writing scratch buffers cannot collide even though they address the same `SharedArrayBuffer`. Sound design, paying rent on an empty building.

## Getting a chunk to a thread

The fragment pool has the harder problem. A `DataChunk` is a JavaScript object holding typed arrays ([chapter 4](../00-orientation/04-rows-columns-and-chunks.md)). `postMessage` would either structured-clone every byte or transfer the buffers away from the sender. [`chunk-transport.ts`](../../src/parallel/chunk-transport.ts) does neither.

Three steps.

**Get the bytes into shared memory.** [`shareChunk`](../../src/parallel/chunk-transport.ts) checks whether a column's arrays already live in a `SharedArrayBuffer`, using [`isSharedView`](../../src/storage/sab-arena.ts). If they do, the chunk is passed through untouched. If not, [`copyColumn`](../../src/parallel/chunk-transport.ts) reallocates each array from a [`SabArena`](../../src/storage/sab-arena.ts) — a bump allocator over `SharedArrayBuffer` segments that double in size as they fill.

**Describe the layout.** [`encodeChunkSet`](../../src/parallel/chunk-transport.ts) writes a flat `Uint32Array` of metadata — sixteen words per column per chunk, holding a kind tag, a type id, and buffer/offset/length triples for the data, the null bitmap, and up to two auxiliary arrays. Buffers are de-duplicated by identity, so a hundred columns cut from the same arena segment reference the same buffer id. The result is `{ buffers, meta, sizes, colCount }`, and only that goes through `postMessage`.

**Rebuild lazily on the other side.** [`ChunkSetReader`](../../src/parallel/chunk-transport.ts) reconstructs a `DataChunk` on demand, wrapping typed-array views directly over the shared buffers, and caches what it builds. A worker that claims only morsels 8–15 never materializes the other 110 chunks.

Measured on 118 chunks of `ORDERS`, all four columns:

```
QE_SAB_COLUMNS=false {"first":3,"retried":false,"buffers":3,"bytes":7340032,"arenaBytes":7340032}
```

Three `SharedArrayBuffer`s cross the boundary, not 472 typed arrays.

### The knob that makes it worse

`Config.sabColumns`, from `QE_SAB_COLUMNS`, tells [`columnAllocator`](../../src/storage/sab-arena.ts) to allocate every column out of shared memory in the first place, so `shareChunk` would have nothing to copy. Turn it on and:

```
QE_SAB_COLUMNS=true  {"first":238,"retried":true,"buffers":2,"bytes":6291456,"arenaBytes":7340032}
```

The copy is indeed skipped — and the first encode produces **238** buffers, because each column got its own `SabArena` and therefore its own segment. That trips the guard in [`encodeForTransport`](../../src/parallel/fragment-pool.ts):

```typescript
if (encoded.buffers.length > Config.transportMaxBuffers) {
  shared = chunks.map(chunk => shareChunk(chunk, columnIndexes, arena, true));
  encoded = encodeChunkSet(shared, columnIndexes, arena, dictCache);
}
```

`transportMaxBuffers` is 64. Over the limit, everything is copied into one arena with `forceCopy` — the copy the flag was meant to avoid, now after a wasted encode. The default does one copy; the flag does one encode, one copy, and one more encode.

There is a byte limit too. [`runAggregate`](../../src/parallel/fragment-pool.ts) refuses outright if the encoded set exceeds `Config.parallelAggMemoryBytes`:

```typescript
if (byteLimit > 0 && transportBytes(encoded) > byteLimit) return (null as DataChunk[] | null) as DataChunk[];
```

Returning `null` is not an error. The aggregate builder treats it as a decline and runs the serial sub-pipeline instead.

## Aggregating in two phases

With the data shared and a morsel scheduler attached, [`handleAggregate`](../../src/parallel/fragment-worker.ts) is a loop:

```typescript
for (const { start, end } of scheduler.drain()) {
  for (let i = start; i < end; i++) {
    let chunk: DataChunk | null = reader.chunk(i);
    for (const op of operators) {
      if (!chunk || chunk.size === 0) break;
      chunk = await op.process(chunk);
    }
    if (!chunk || chunk.size === 0) continue;
    ...
    maybeSpill();
  }
}
```

Each worker ends up with its own partial groups. It does not return a hash table; it returns `exportPartials(partitionCount)`, the groups **radix-partitioned by group key**, so partition *p* from every worker holds exactly the groups belonging in partition *p*. The count is derived from the pool size:

```
workerCount 11, aggRadixMultiplier 2, parallelCombineMinGroups 8192
partitionCount = nextPowerOfTwo(workerCount * aggRadixMultiplier) = 32
```

[`_combineAndFinalize`](../../src/parallel/fragment-pool.ts) then slices those 32 partitions across workers and merges each one independently — but only if the merge is big enough to be worth another round trip:

```typescript
const useWorkerCombine = spillFiles.length > 0
  || (totalGroups >= Config.parallelCombineMinGroups && this.workers.length > 1);
```

Two real queries over the same table, differing only in the grouping column:

```
group by date (7 groups)
  aggregate broadcast -> 11 replies, 28 non-empty partitions, 28 partial groups, spillFiles=0
  rows=7 follow-up _request calls=0
group by custkey (7664 groups)
  aggregate broadcast -> 11 replies, 352 non-empty partitions, 57794 partial groups, spillFiles=0
  rows=7664 follow-up _request calls=32
```

Seven groups produce 28 partial records — the main thread absorbs them itself. Seven thousand groups produce 57,794, above the 8,192 threshold, so 32 combine requests go back out, one per partition. Note the fan-out shape: phase one is a [`_broadcast`](../../src/parallel/fragment-pool.ts), one message to every worker racing on the shared counter; phase two is 32 targeted [`_request`](../../src/parallel/fragment-pool.ts) calls, because each partition has one owner.

The join takes the same shape. [`runJoinStream`](../../src/parallel/fragment-pool.ts) broadcasts a `joinPartition` task, where each worker hashes its morsels of both sides into `(chunkIndex, rowIndex)` reference pairs, then issues one probe request per non-empty partition pair:

```
hash join
  joinPartition broadcast -> 11 replies
  rows=1 follow-up _request calls=32
```

Only *references* are shuffled between the two phases — `Uint32Array`s of chunk and row indices. The rows themselves never move, because both phases read the same shared arena.

## Spilling partial aggregates

A worker that accumulates too many groups spills. [`maybeSpill`](../../src/parallel/fragment-worker.ts) checks after every chunk:

```typescript
const maybeSpill = (): void => {
  if (!spill || groupCount() <= spill.groupLimit) return;
  const file = path.join(spill.dir, `${spill.tag}_${threadId}_${spillFiles.length}.partials`);
  writePartialSpill(file, exportPartitions());
  spillFiles.push(file);
  resetGroups();
};
```

The limit is `Config.aggSpillGroups`, 131,072. The file name carries the worker's `threadId`, so eleven workers spilling at once cannot collide.

[`writePartialSpill`](../../src/parallel/partial-spill.ts) writes a small directory — a partition count, then one length per partition — followed by each partition's `v8.serialize` output. [`readPartialSpill`](../../src/parallel/partial-spill.ts) sums the preceding lengths to get an offset and deserializes exactly one partition. That layout keeps the combine phase parallel after a spill: partition 7's combiner reads partition 7 out of all eleven files without touching the rest. It also explains the first clause of `useWorkerCombine` — once anything has spilled, the merge goes to the workers regardless of group count.

Unlike the spill files in [chapter 43](../05-storage/43-serialization-and-spill.md), these hold accumulator *states*, not rows — a `PartialGroupRecord` is a group's key values plus one state per aggregate, which for `AVG` is a `{ sum, count }` pair. Chapter 47 needs exactly that pair for a completely different reason.

## When a worker dies

[`FragmentPool`](../../src/parallel/fragment-pool.ts) keeps every outstanding request in a map keyed by request id, with an expected reply count. Three behaviors follow from that.

**A crash fails every in-flight query, then heals.** The `exit` handler calls `_failAll` and respawns into the same slot, so the next query finds a full pool. The failed request is not retried — the aggregate builder catches the rejection and falls back to the serial pipeline.

**Workers do not keep the process alive.** `worker.unref()` at spawn, and [`_updateRefs`](../../src/parallel/fragment-pool.ts) re-`ref`s them only while requests are pending. A REPL sitting idle with eleven workers still exits on `Ctrl-D`.

**Partial replies are held, not streamed.** `_broadcast` resolves only when `replies.length === expected`. The aggregate's first phase is a barrier: every worker must finish its morsels before any combining starts.

## In the code

| Idea | Where |
|---|---|
| Kernel worker pool | [`WorkerPool`](../../src/parallel/worker-pool.ts) |
| Kernel worker entry point | [`src/parallel/worker-thread.ts`](../../src/parallel/worker-thread.ts) |
| Fragment worker pool | [`FragmentPool`](../../src/parallel/fragment-pool.ts) |
| Fragment worker entry point | [`src/parallel/fragment-worker.ts`](../../src/parallel/fragment-worker.ts) |
| Message shapes for both | [`src/parallel/worker-messages.ts`](../../src/parallel/worker-messages.ts) |
| Shared bump allocator | [`SabArena`](../../src/storage/sab-arena.ts) |
| Non-shared fallback | [`HeapAllocator`](../../src/storage/sab-arena.ts) |
| Chunks into shared memory | [`shareChunk`](../../src/parallel/chunk-transport.ts) |
| Layout descriptor | [`encodeChunkSet`](../../src/parallel/chunk-transport.ts) |
| Lazy rebuild | [`ChunkSetReader`](../../src/parallel/chunk-transport.ts) |
| Partial-aggregate spill format | [`writePartialSpill`](../../src/parallel/partial-spill.ts) |

| Setting | Default | Effect |
|---|---|---|
| `parallelWorkers` | CPU count − 1 | threads in each pool |
| `regionSize` | 16 MiB | WebAssembly memory reserved per kernel worker |
| `sabColumns` | off | allocate every column in shared memory |
| `sabArenaSegmentBytes` | 1 MiB | first arena segment; doubles thereafter |
| `transportMaxBuffers` | 64 | above this, re-copy into one arena |
| `parallelAggMemoryBytes` | 256 MB | decline the parallel path above this |
| `aggRadixMultiplier` | 2 | partitions = next power of two of workers × this |
| `parallelCombineMinGroups` | 8192 | below this, merge on the main thread |
| `aggSpillGroups` | 131072 | groups per worker before spilling |

## Traps

**These are threads, not machines.** Everything here depends on `SharedArrayBuffer` being the same physical bytes on both sides. `src/distributed/` shares the words "worker" and "partition" and none of the mechanism; chapter 49's transport copies bytes over HTTP precisely because it cannot do this.

**`shareChunk` may return its input.** An already-shared chunk is passed through, so worker and main thread hold views over identical memory. Nothing writes to those views, but the sharing is real, not a copy that happens to be equal.

**A `null` return from `runAggregate` is a decline, not a failure.** It means the encoded input was larger than the byte limit. The query still runs, serially.

**The error message when threads fail to start names the wrong cause.** `enableParallel` swallows the exception and the CLI prints "WASM required" for any failure at all, including a missing worker script or a `SharedArrayBuffer` that the runtime will not create.

## Exercises

1. Run the CLI from `dist/index.cli.js` and again from the per-file build, and compare the `[parallel]` line. Then patch the `catch (_)` in a copy of the bundle to log the error, and confirm the module it cannot find.

2. Print `loader.memory.buffer.byteLength` before and after `enableParallel()`. Set `QE_WASM_REGION_SIZE` to 1 MiB and re-measure. Does any query get slower?

3. Run a grouped aggregate with `QE_SAB_COLUMNS=1` and instrument `encodeForTransport` to report the buffer count before and after the retry. Explain the 238 in terms of how `columnAllocator` allocates.

4. Find the group count at which the combine phase moves from the main thread to the workers, by bisecting `QE_PARALLEL_COMBINE_MIN_GROUPS` against a query with a known number of groups. Time both sides of the boundary.

5. Force a partial-aggregate spill by setting `QE_AGG_SPILL_GROUPS` to something small, and confirm the results are unchanged. Then read `readPartialSpill` and explain why the combine phase can still run one partition per worker.

## Recap

- Both worker pools locate their entry script relative to their own module, so the **esbuild bundle cannot start either one** — and `enableParallel`'s bare `catch` reports every failure as "WASM required".
- `WorkerPool` reserves a private 16 MiB region of shared WebAssembly memory per thread — **176 MiB measured** — and receives no tasks. `FragmentPool` does all the work.
- Chunks cross the thread boundary by being copied once into a **`SabArena`**, described by a flat metadata array with de-duplicated buffer ids, and rebuilt lazily by `ChunkSetReader`. Only the buffers and the descriptor are posted.
- `QE_SAB_COLUMNS` skips that copy but gives each column its own buffer; past `transportMaxBuffers` the pool copies everything anyway, so the flag costs an extra encode.
- Aggregates run **broadcast, then per-partition**: partials are radix-partitioned by group key into `nextPowerOfTwo(workers × 2)` partitions, merged on the main thread below 8,192 groups and on the workers above it. Joins use the same two-phase shape, shuffling only row references.
- Spilled partials are stored one serialized blob per partition behind a length index, so the merge stays parallel after a spill.

Next: [chapter 47](47-fragments-and-exchange.md) leaves shared memory behind. The same words — worker, partition, exchange — now mean separate processes, and the first thing that breaks is `AVG`.
