# 32. Scans and zone maps

> After this chapter you will be able to predict how many chunks a filtered scan reads, and explain why moving one `WHERE` clause can change that number from all of them to one.

## The question

A table of 100,000 rows, held as 49 chunks. Two queries, each returning a handful of rows out of a hundred thousand:

```
O_ORDERKEY BETWEEN 5000 AND 5100   scanned= 1 skipped=48  rows=101
O_CUSTKEY = 3                      scanned=20 skipped=29  rows=20
O_TOTALPRICE > 8000                scanned=49 skipped= 0  rows=12207
```

The first reads one chunk out of 49. The third reads all of them. Nothing about the *shape* of these queries differs — one column, one comparison, one literal — and the engine has no index on any of them.

The difference is a data structure that costs 49 pairs of numbers per column and is consulted before a single row is read. This chapter is about that structure, why the first query gets almost everything for free, and why the third gets nothing.

## A scan is a generator

[`ScanOperator`](../../src/execution/operators/scan.ts) is thirty-eight lines, and the interesting half is this:

```typescript
async *scan(): AsyncGenerator<DataChunk> {
  for await (const chunk of this.table.scan(this.pruner)) {
    if (this.projectedColumns) {
      yield chunk.project(this.projectedColumns);
    } else {
      yield chunk;
    }
  }
}
```

It does two things: it forwards a pruner to storage, and it narrows each chunk to the columns the plan needs. Both are cheap. [`project`](../../src/storage/chunk.ts) builds a chunk holding a subset of the *same* column objects — no data is copied, and dropping a column costs one array allocation.

Which columns to keep is decided at build time by [`resolveProjectedColumnIndexes`](../../src/execution/execution-context.ts), which maps the scan node's column list onto the storage schema and returns `null` — meaning "keep everything" — if the plan wants as many columns as the table has. So column pruning is a planning-time fact that the scan applies mechanically.

Everything else about reading rows belongs to storage, which chapters 40 through 42 cover. What matters here is the one argument the scan passes down.

## Zone maps

A **zone map** is a summary of a chunk: for each column, the smallest and largest value it contains, and whether it contains any nulls. [`ChunkZoneMap`](../../src/storage/zone-map.ts) is the whole type:

```typescript
export interface ColumnZoneMap {
  readonly range: ValueRange | null;
  readonly hasNulls: boolean;
}

export interface ChunkZoneMap {
  readonly rowCount: number;
  readonly columns: ReadonlyArray<ColumnZoneMap>;
}
```

[`buildChunkZoneMap`](../../src/storage/zone-map.ts) computes one by walking the chunk once per column. `range` is `null` when every value in the column is null, which is distinct from the column having no nulls at all — both facts are recorded, and the pruner uses both.

For an in-memory table, [`InMemoryRelation`](../../src/dataframe/in-memory-relation.ts) builds them lazily and caches them:

```typescript
zoneMaps(): ChunkZoneMap[] {
  if (this._zoneMaps === null) {
    this._zoneMaps = this.chunks.map(buildChunkZoneMap);
  }
  return this._zoneMaps;
}
```

For a paged table, [`Table`](../../src/storage/table.ts) computes each chunk's zone map at the moment the chunk is written and keeps the array alongside the page ids, so pruning a page never requires reading it back.

The table in the opening experiment is loaded with `O_ORDERKEY` ascending, so the chunk boundaries fall on clean ranges:

```
chunks in ORDERS: 49
chunk 0 zone map, O_ORDERKEY range: {"min":1,"max":2048}
chunk 7 zone map, O_ORDERKEY range: {"min":14337,"max":16384}
chunk 0 zone map, O_CUSTKEY range : {"min":1,"max":2048}
```

That is the whole reason the first query is fast, and the whole reason the third is not. Correlation between a column's values and their physical position is what makes a zone map informative. `O_TOTALPRICE` in this table cycles through its range every few hundred rows, so every chunk's range is nearly the full range and no chunk can be excluded.

## Skipping

The scan loop in storage is one line longer than the unpruned one:

```typescript
async *scan(pruner: ChunkPruner | null = null): AsyncGenerator<DataChunk, void, void> {
  if (!pruner) {
    yield* this.chunks;
    return;
  }
  const zoneMaps = this.zoneMaps();
  for (let i = 0; i < this.chunks.length; i++) {
    if (pruner.canSkip(zoneMaps[i])) continue;
    yield this.chunks[i];
  }
}
```

A [`ChunkPruner`](../../src/storage/zone-map.ts) answers one question — `canSkip(zoneMap)` — and it must never say yes when a matching row exists. Saying no when it could have said yes is merely a missed optimization.

## Compiling a predicate into a pruner

[`compileChunkPruner`](../../src/execution/zone-map-pruner.ts) turns a bound predicate into that function. The interesting design decision is that it does not evaluate the predicate to a boolean. It evaluates it to a **set of truth values the predicate could take** over the rows of the chunk:

```typescript
const IS_TRUE = 1;
const IS_FALSE = 2;
const IS_UNKNOWN = 4;
const ANY_TRUTH = IS_TRUE | IS_FALSE | IS_UNKNOWN;
```

A three-bit mask. If `IS_TRUE` is not in the result, no row in the chunk can satisfy the predicate, and the chunk is skippable:

```typescript
return { canSkip: (zoneMap) => zoneMap.rowCount === 0 || (evaluate(zoneMap) & IS_TRUE) === 0 };
```

Carrying all three bits rather than only "possibly true" is what lets `NOT` work. [`kleeneNot`](../../src/execution/zone-map-pruner.ts) swaps the true and false bits and leaves unknown alone; [`kleeneAnd`](../../src/execution/zone-map-pruner.ts) and [`kleeneOr`](../../src/execution/zone-map-pruner.ts) combine two masks according to SQL's three-valued logic. A predicate that could only ever be false or unknown over a chunk is one whose negation is worth pruning on, and you cannot express that with a single "might match" bit.

For a comparison, the rule table is direct. Comparing the chunk's `min` and `max` against the literal gives two integers, `lo` and `hi`, and each operator says what those two permit:

```typescript
'=': {
  possiblyTrue: (lo, hi) => lo <= 0 && hi >= 0,
  possiblyFalse: (lo, hi) => !(lo === 0 && hi === 0),
},
'<': {
  possiblyTrue: (lo) => lo < 0,
  possiblyFalse: (_lo, hi) => hi >= 0,
},
```

`=` can be true only if the literal falls inside `[min, max]`, and can be false unless the chunk is a single repeated value equal to the literal. `<` can be true only if the minimum is below the literal.

Six comparison operators are supported, plus `BETWEEN` (compiled as two comparisons combined with `kleeneAnd`), `IS NULL` and `IS NOT NULL` (answered from `hasNulls` and whether `range` exists), `IN` over literal lists, and `LIKE` with a literal prefix. That last one is the neatest: [`literalPrefixOf`](../../src/execution/zone-map-pruner.ts) takes the fixed characters before the first wildcard, [`nextPrefix`](../../src/execution/zone-map-pruner.ts) increments the last character to get an exclusive upper bound, and the pruner then treats `LIKE 'Customer#4%'` as a string range test.

Anything else compiles to `anyTruth`, the constant that returns all three bits. And when the *whole* predicate compiles to `anyTruth`, `compileChunkPruner` returns `null` rather than a pruner that always says no — so a scan with an unprunable filter takes the `if (!pruner)` fast path and pays nothing.

## How a predicate reaches the scan

A `Filter` node sits above a `Scan` in the logical plan; the scan itself has no predicate. The connection is made by one optimizer pass, [`ScanPruning`](../../src/optimizer/passes/scan-pruning.ts), which is short enough to quote entirely:

```typescript
override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
  const child = this.rewrite(node.children[0]);
  if (child.type !== PlanNodeType.SCAN || !node.condition) {
    return child === node.children[0] ? node : { ...node, children: [child] };
  }

  const scan: LogicalScanNode = { ...child, pruningFilter: node.condition };
  return { ...node, children: [scan] };
}
```

It copies the filter's condition onto the scan as `pruningFilter` and **leaves the filter in place**. The filter still runs on every row of every chunk that survives. Pruning is a pure addition: it removes work without removing a correctness check, which is why an over-eager pruner would be a bug and an under-eager one merely slow.

The condition is *copied*, not moved, and only when the filter's immediate child is a scan. So this pass is entirely dependent on [predicate pushdown](../03-optimizer/17-predicate-pushdown.md) having already moved the predicate down to the scan. A `WHERE` clause that pushdown could not move past a join never becomes a pruning filter.

[`buildScan`](../../src/execution/builders/source-builders.ts) does the compilation at pipeline-build time:

```typescript
const pruner = Config.zoneMapPruning
  ? compileChunkPruner(node.pruningFilter ?? null, schemaColumnResolver(schema, alias))
  : null;
```

[`schemaColumnResolver`](../../src/execution/zone-map-pruner.ts) maps a column reference to an index in the *storage* schema, and refuses — returning `UNRESOLVED_COLUMN` — for any reference that is correlated, at a nonzero depth, or qualified with a different table alias. Those references would name columns that are not in this chunk.

## The numbers

With `QE_ZONE_MAP_PRUNING` at its default of on:

```
O_ORDERKEY = 60000                 scanned= 1 skipped=48  rows=1
O_ORDERKEY BETWEEN 5000 AND 5100   scanned= 1 skipped=48  rows=101
O_ORDERKEY > 90000                 scanned= 6 skipped=43  rows=10000
O_CUSTKEY = 3                      scanned=20 skipped=29  rows=20
O_TOTALPRICE > 8000                scanned=49 skipped= 0  rows=12207
O_ORDERKEY < 0                     scanned= 0 skipped=49  rows=0
```

And with `QE_ZONE_MAP_PRUNING=0`, every line reads 49 chunks and every line returns the same rows.

Four regimes are visible. `O_ORDERKEY` is perfectly correlated with position, so equality and range predicates on it read the minimum possible. `O_CUSTKEY` cycles every 5,000 rows over 100,000 rows, so customer 3 appears in 20 chunks and all 20 must be read — the zone map is right, and 29 chunks are still saved. `O_TOTALPRICE` cycles fast enough that every chunk spans nearly the whole range, and pruning is a pure loss of 49 mask evaluations. And a predicate no chunk can satisfy prunes everything, so the scan yields nothing at all and the query returns without touching a row.

## In the code

| Idea | Where |
|---|---|
| Scan operator | [`ScanOperator`](../../src/execution/operators/scan.ts) |
| Column pruning at build time | [`resolveProjectedColumnIndexes`](../../src/execution/execution-context.ts) |
| Zone map shape | [`ChunkZoneMap`](../../src/storage/zone-map.ts) |
| Computing one | [`buildChunkZoneMap`](../../src/storage/zone-map.ts) |
| The pruner interface | [`ChunkPruner`](../../src/storage/zone-map.ts) |
| Predicate to pruner | [`compileChunkPruner`](../../src/execution/zone-map-pruner.ts) |
| Three-valued combination | [`kleeneAnd`](../../src/execution/zone-map-pruner.ts) |
| Comparison rules | [`RANGE_RULES`](../../src/execution/zone-map-pruner.ts) |
| `LIKE` prefix bound | [`literalPrefixOf`](../../src/execution/zone-map-pruner.ts) |
| Column reference resolution | [`schemaColumnResolver`](../../src/execution/zone-map-pruner.ts) |
| Attaching the predicate | [`ScanPruning`](../../src/optimizer/passes/scan-pruning.ts) |
| Cached maps, in-memory table | [`InMemoryRelation`](../../src/dataframe/in-memory-relation.ts) |
| Maps written with pages | [`Table`](../../src/storage/table.ts) |
| On/off switch | `zoneMapPruning` in [`config.ts`](../../src/config.ts) |

## Traps

**Zone maps prune chunks, not rows.** A chunk that contains one matching row is read in full and filtered normally. The win is proportional to how many chunks can be excluded, which is a property of the data's physical order, not of the predicate's selectivity. A highly selective predicate on an uncorrelated column prunes nothing.

**Statistics collection scans the table without a pruner.** The first query against a fresh table triggers `_ensureStatistics`, which reads every chunk. If you are counting chunks, warm the statistics with a throwaway query first or the count will be 49 too high.

**The scan yields the same chunk object storage holds.** [`InMemoryRelation.scan`](../../src/dataframe/in-memory-relation.ts) yields entries of `this.chunks` directly; the paged `Table` yields a [`scanView`](../../src/storage/chunk.ts). Neither is a copy. An operator that writes into a column it received from a scan corrupts the table.

**A pruning filter is a copy, and both copies run.** The predicate on the scan node and the `Filter` above it are the same expression evaluated twice with different arguments — once against 49 zone maps, once against every surviving row. Removing the `Filter` because "the scan already handles it" would return wrong answers for every chunk that was not fully pruned.

**`min` and `max` are compared with the pruner's own ordering, not the column's.** [`isBefore`](../../src/storage/zone-map.ts) coerces to string when either side is a string and to number otherwise, and [`compareComparable`](../../src/execution/zone-map-pruner.ts) returns `NaN` for mixed types, which the evaluator treats as "all three truth values" — the safe answer. A column of mixed-type values therefore prunes nothing rather than pruning wrongly.

## Exercises

1. Reproduce the chunk counts. Remember to warm statistics first. Then run the same six predicates with `QE_ZONE_MAP_PRUNING=0` and confirm the row counts are identical.

2. Shuffle `ORDERS` before loading it so `O_ORDERKEY` is uncorrelated with position, and rerun. Explain the new numbers in one sentence.

3. `O_CUSTKEY = 3` reads 20 chunks. Predict — before running it — how many chunks `O_CUSTKEY BETWEEN 3 AND 400` reads, then check.

4. Add a rule to `RANGE_RULES` or a compiler to `EXPR_COMPILERS` for an expression form that currently falls through to `anyTruth`. `LIKE '%suffix'` is not one of them; explain why not.

5. Break the pruner deliberately: change `=`'s `possiblyTrue` to `(lo, hi) => lo < 0 && hi > 0`. Find a query that now returns the wrong answer, and say which property of `canSkip` you violated.

## Recap

- A **zone map** is a per-chunk, per-column `min`, `max`, and null flag, built once and cached. It lets a scan decide whether to read a chunk without reading it.
- A predicate is compiled into a [`ChunkPruner`](../../src/storage/zone-map.ts) that evaluates over a zone map to a **three-bit truth set**, not a boolean, so `NOT`, `AND`, and `OR` compose under SQL's three-valued logic.
- `canSkip` may only be true when no row could match. Being conservative is free; being wrong loses rows.
- The predicate reaches the scan by [`ScanPruning`](../../src/optimizer/passes/scan-pruning.ts) **copying** it from a directly overlying `Filter`, which still runs. Pruning never replaces filtering.
- How much it saves depends on **correlation between value and physical position**, not on selectivity: a sorted key prunes 48 chunks out of 49; a fast-cycling column prunes none.
- Unprunable predicates compile to `null` rather than to a pruner that never skips, so the unpruned scan path costs nothing extra.

Next: [chapter 33](33-filters-and-expression-evaluation.md) picks up the rows that survive the scan, and shows what a filter does to a chunk without copying it.
