# 31. Vectorized execution: why 2,048

> After this chapter you will know what the 2,048 in `DEFAULT_CHUNK_SIZE` buys, measured rather than asserted, and which execution paths process whole batches.

## The question

Chapter 4 introduced the default of 2,048 rows per chunk. Small chunks pay setup costs more often; larger ones change the working set and scheduling granularity. The original manuscript reported this sweep over 4,194,304 `FLOAT64` rows through a projection and filter. Its environment was not recorded, so treat the timings as an illustration and repeat the sweep on your workload:

```
chunk size | project ms | filter ms   (4,194,304 rows total)
         1 |     2469.1 |    1141.3
         8 |      371.9 |      88.7
        64 |       83.4 |      43.9
       512 |       43.6 |      13.0
      2048 |       35.0 |       8.0
      8192 |       46.8 |      12.9
     65536 |       40.6 |       8.9
   1048576 |       26.1 |       6.4
   4194304 |       25.6 |       5.3
```

The left half is exactly as advertised: one row at a time is 70 times slower than 2,048 at a time, and the curve is flat by the low hundreds. The right half is not. **One chunk of four million rows is the fastest configuration in this benchmark**, by about 30 percent — the cache cliff the argument predicts does not appear.

That is worth taking seriously rather than explaining away, and it tells you something specific about what 2,048 is really for.

## What the overhead actually is

The smaller chunk sizes illustrate the per-chunk overhead in this experiment. Look at what happens per chunk in [`ProjectionOperator`](../../src/execution/operators/projection.ts):

```typescript
async process(chunk: DataChunk): Promise<DataChunk> {
  if (chunk.size === 0) return new DataChunk([], 0);

  const outputCols: AnyColumn[] = [];
  const needsFlatten = !!chunk.selectionVector;

  for (let e = 0; e < this.evaluators.length; e++) {
    ...
    const col = new Column(dataType, chunk.size || 1);
    for (let i = 0; i < chunk.size; i++) {
      const rowIdx = chunk.activeRowIndex(i);
      const val = evalFn(chunk, rowIdx);
      col.set(i, ...);
    }
    ...
  }
  return new DataChunk(outputCols, chunk.size);
}
```

Per chunk: an `async` function call and the promise it returns, a loop over expressions, a `Column` allocation with a typed array and a null bitmap, and a `DataChunk` allocation. Per row: one `activeRowIndex`, one call through `evalFn`, one `col.set`.

At one row per chunk the fixed part is paid four million times and dominates completely. At 2,048 it is amortized to a two-thousandth of its weight, which is roughly nothing. Everything past that point is amortizing a cost that has already stopped mattering — which is exactly what the flat right half of the table shows.

## Why the cliff did not appear

The cache argument is not wrong; the benchmark is a single sequential pass over one 8-byte column. Sequential access can benefit from hardware prefetching, while larger chunks pay fixed costs fewer times. That is a plausible explanation for these measurements; the timing table alone does not isolate cache misses or prefetch behavior.

Cache pressure can become more visible when an operator makes **more than one pass** over a chunk or touches several columns at once. Then the working set has to survive from one pass to the next, and a chunk that does not fit in cache is re-fetched from memory each time. [`_executeAnd`](../../src/execution/operators/filter.ts) is a two-pass operator of exactly that kind: it evaluates the left predicate over the whole chunk, then the right one, then intersects the two selection vectors. [`materializeEvals`](../../src/execution/operators/window.ts) builds one array per window input and then [`partitionsOf`](../../src/execution/operators/window.ts) and `sortedPartition` walk those arrays again. And the hash join's build partitions rows into sixteen buckets, so the write stream is sixteen cursors instead of one.

The supported conclusion is narrower: **2,048 amortizes much of the fixed overhead in this experiment and limits batch size.** Whether a working set fits in cache depends on the operator, live columns, data representation, and hardware. This benchmark does not establish a universally best chunk size.

There is one more consideration that no benchmark shows. A chunk is the unit of latency: a streaming query cannot emit its first row until the first chunk is complete, and [`ResultSink`](../../src/execution/result-sink.ts) queues at most `sinkQueueCapacity` — eight — chunks of backpressure. Bigger chunks mean coarser scheduling and later first rows.

## The constant

```typescript
export const DEFAULT_CHUNK_SIZE = 2048;
```

That is the whole of it in [`config.ts`](../../src/config.ts), and it is worth noticing what is missing. Almost every setting in that file is written `env('QE_SOMETHING', default)` and can be changed without recompiling. `DEFAULT_CHUNK_SIZE` is a plain exported constant with **no environment variable**. It is read directly by [`InMemoryRelation`](../../src/dataframe/in-memory-relation.ts) and the paged [`Table`](../../src/storage/table.ts) when they cut rows into chunks, by [`DataChunk.fromSchema`](../../src/storage/chunk.ts), by the CSV and JSON loaders, and by [`emitResidentGroups`](../../src/execution/operators/hash-aggregate.ts) when it slices finished groups into output chunks.

The value does appear as a default for one tunable:

```typescript
flushBatchSize: env('QE_FLUSH_BATCH_SIZE', DEFAULT_CHUNK_SIZE),
```

`flushBatchSize` is what operators that build rows in a list use when cutting that list into chunks — the merge join's `drain`, the sort's output loop, the hash join's spill batches. So you can change the size of *derived* chunks from the environment, but the size of chunks coming out of storage is a code change.

## Two evaluators, one loop each

"Vectorized" is often taken to mean that an expression is evaluated over a whole column with a typed-array loop, rather than row by row through a tree walk. This engine does that for a narrow, precisely delimited class of expressions, and does the row-by-row thing for everything else.

The narrow class is [`compileColumnarProjection`](../../src/execution/columnar-projection.ts). It accepts an expression only if it is a binary or unary node, and then recursively only if every leaf is a numeric literal or a fixed-width numeric column that is not `INT64` or `DECIMAL`, and every operator is one of `+ - * /`:

```typescript
const ARITHMETIC_OPS: Record<string, NumericBinaryOp> = {
  '+': (left, right) => left + right,
  '-': (left, right) => left - right,
  '*': (left, right) => left * right,
  '/': (left, right) => (right === 0 ? null : left / right),
};
```

When it accepts, the inner loop of [`binaryProjection`](../../src/execution/columnar-projection.ts) is a typed-array loop with no null checks at all:

```typescript
const target = output.data as Float64Array;
if (leftData && rightData) {
  for (let i = 0; i < size; i++) target[i] = apply(leftData[i], rightData[i]) as number;
} else if (leftData) {
  for (let i = 0; i < size; i++) target[i] = apply(leftData[i], rightConstant) as number;
}
```

That branch is taken only when the operation is **total** — `+`, `-`, `*`, or a division by a nonzero constant, tracked by the `total` flag — and no input column has nulls. Otherwise the same function falls back to a per-element loop that checks `isNull` and calls `output.set`.

The difference is worth measuring. Same 4,194,304 rows in 2,048-row chunks, through `ProjectionOperator`:

```
A * 2 -> columnar projection compiled: true
ABS(A) -> columnar projection compiled: false

A * 2   (columnar): 20.8 ms
ABS(A)  (scalar)  : 109.3 ms
```

Five times, for two expressions that do a comparable amount of arithmetic. `ABS` is a `FUNCTION` node, and `compileColumnarProjection` accepts only a binary or unary root, so it goes through [`compileExpression`](../../src/execution/expression-eval.ts) — the closure-tree evaluator chapter 33 covers — once per row.

The gate is narrower still than it looks. `ProjectionOperator` only tries the columnar path when the declared result type is `FLOAT64`:

```typescript
const columnar = this.columnarProjections[e];
if (columnar && dataType === DataType.FLOAT64) {
```

So an integer expression that `compileColumnarProjection` would happily compile is evaluated row by row anyway, because the compiled projection always produces a `FLOAT64` column and the operator refuses to hand back the wrong type.

## What is not running

Two things in the execution directory look like the vectorized core and are not.

[`src/execution/vector-ops.ts`](../../src/execution/vector-ops.ts) exports [`vectorizedFilter`](../../src/execution/vector-ops.ts), [`vectorizedProject`](../../src/execution/vector-ops.ts), [`compileVectorExpression`](../../src/execution/vector-ops.ts), [`vectorizedHashProbe`](../../src/execution/vector-ops.ts), and [`buildJoinOutputDirect`](../../src/execution/vector-ops.ts). **Nothing in `src/` imports any of them.** The file's only consumer is its own unit test. `FilterOperator._executeFallback` contains a loop that is line-for-line what `vectorizedFilter` does, written out again; the shared version is dead. Read the file for its intent, not for what runs.

[`tryWasmProject`](../../src/execution/operators/projection.ts) is live code with gates it does not normally pass:

```typescript
async function tryWasmProject(expr, chunk, columnMapping): Promise<Column | null> {
  if (!isVectorizableExpr(expr)) return null;
  if (chunk.size < Config.wasmMinChunkSize) return null;
  ...
}
```

The first gate is only a shape test. [`isVectorizableExpr`](../../src/execution/wasm-expr-eval.ts) accepts a numeric column reference, a numeric literal, `+ - * /` over two such operands, or unary minus, and knows nothing about whether a kernel exists to run them.

For default-size storage chunks, the second gate prevents lookup: `wasmMinChunkSize` is 4,096, while those chunks hold at most 2,048 rows. Derived chunks or changed settings can have different sizes. Chapter 54 measures this gate for one concrete projection.

The kernel check is a third gate, one level further down. [`evalVectorized`](../../src/execution/wasm-expr-eval.ts) opens with `if (dispatch.kernels.size === 0) return null;`, and that table stays empty until kernels are registered. The CLI calls `enableWasm()` during startup; library users can call it explicitly. A sufficiently large chunk still needs a registered kernel for the operation and type.

## In the code

| Idea | Where |
|---|---|
| The constant | [`DEFAULT_CHUNK_SIZE`](../../src/config.ts) |
| Derived chunk size, tunable | [`Config`](../../src/config.ts) |
| Per-chunk projection loop | [`ProjectionOperator`](../../src/execution/operators/projection.ts) |
| Typed-array arithmetic | [`compileColumnarProjection`](../../src/execution/columnar-projection.ts) |
| The total-operation fast path | [`binaryProjection`](../../src/execution/columnar-projection.ts) |
| Row-at-a-time fallback | [`compileExpression`](../../src/execution/expression-eval.ts) |
| Which expressions a kernel could take | [`isVectorizableExpr`](../../src/execution/wasm-expr-eval.ts) |
| Where the kernel table is consulted | [`evalVectorized`](../../src/execution/wasm-expr-eval.ts) |
| Null propagation for WASM results | [`applyNullMask`](../../src/execution/operators/projection.ts) |
| Dormant vector helpers | [`src/execution/vector-ops.ts`](../../src/execution/vector-ops.ts) |

## Traps

**Vectorized here means "a loop over a column", not SIMD.** There is no explicit vector instruction anywhere in the TypeScript. The win is removing per-row dispatch and allocation, not doing four lanes at once. The AssemblyScript kernels under [`src/wasm/assembly/`](../../src/wasm/assembly/aggregate.ts) are the only place with a different execution model, and chapter 54 distinguishes loading those kernels from actually invoking them.

**The columnar path gathers when there is a selection vector.** [`denseColumn`](../../src/execution/columnar-projection.ts) copies selected rows into a fresh `FLOAT64` column before the arithmetic loop, so a filtered chunk pays a materialization the unfiltered one does not. For a very selective filter that gather is cheap; for one that keeps most rows it costs a full copy.

**A `Project` of a bare column copies nothing.** `ProjectionOperator` pushes the source column into the output by reference when the expression is a column reference and the chunk has no selection vector. The output chunk then shares arrays with its input, which is why nothing downstream may write into a column it did not create.

**Bigger chunks are not free even when they are faster.** A chunk is one allocation held live for its whole traversal, and a spill file is written a chunk at a time. Raising `DEFAULT_CHUNK_SIZE` raises the floor of every operator's resident memory, which is the quantity [`RowMemoryBudget`](../../src/execution/memory-budget.ts) is trying to bound.

## Exercises

### Understand

A table has 5,000 rows and batches contain at most 2,048. How many batches are needed, and what fixed costs does batching amortize?

### Practice

1. **Observe.** Reproduce the chunk-size sweep. Then change the benchmark expression from one column to four columns summed together, rerun, and see whether the cliff appears.

2. **Extend (optional).** Time `A * 2` and `ABS(A)` through `ProjectionOperator` and confirm the ratio. Then add `'ABS'` handling to `compileColumnarProjection` and measure again.

3. **Observe.** `ProjectionOperator` gates the columnar path on `dataType === DataType.FLOAT64`. Find an integer-typed projection that `compileColumnarProjection` compiles but the operator never uses, and describe what would have to change for it to be used safely.

4. **Extend (optional).** Change `DEFAULT_CHUNK_SIZE` to 512 and to 16,384, rebuild with `npm run build:ts`, and run the running query at 30,000 customers with `EXPLAIN ANALYZE`. Report the three execution times, and say which operator you think moved.

5. **Extend (optional).** Delete `src/execution/vector-ops.ts` and its test, then run `npm run build:ts` and the suite. Explain what the result tells you about the file, and decide whether deleting it is an improvement.

### Hints and expected observations

Three batches: 2,048, 2,048, and 904. Calls, promises, and per-batch setup are paid three times rather than 5,000; this does not imply SIMD or guaranteed cache fit.

## Recap

- Per-chunk overhead — an async call, a `Column` allocation, a `DataChunk` allocation — is what chunking amortizes, and it has stopped mattering by a few hundred rows.
- Measured on a single-pass operator, larger chunks keep getting slightly faster; **the cache argument for a small chunk applies to multi-pass and multi-column operators**, not to a single streaming loop.
- `DEFAULT_CHUNK_SIZE` is the one setting in [`config.ts`](../../src/config.ts) with **no environment variable**. `flushBatchSize` merely defaults to it.
- Expression evaluation has two implementations: a **typed-array loop** for numeric `+ - * /` over fixed-width columns, and a row-at-a-time closure tree for everything else. The gap between them is about 5x.
- The typed-array loop drops null checking entirely for **total** operations over columns with no nulls; anything else takes the checked path.
- `src/execution/vector-ops.ts` is **dormant** — nothing in `src/` imports it — and the demonstrated WASM projection path is gated out for default-size storage chunks by a larger minimum chunk size.

Next: [chapter 32](32-scans-and-zone-maps.md) starts at the bottom of the plan, where chunks come from — and shows how the engine skips reading most of them.
