# 22. Statistics

> After this chapter you will be able to say what the optimizer knows about your data, how much of it is approximate, and which approximation is wrong in a way that matters.

## The question

Build a table with a column holding exactly 1,000 distinct values, collect statistics, and ask how many distinct values it has:

```
V: ndv=1026 min=0 max=999 nullFraction=0 histogramBuckets=64
```

Twenty-six too many. That is fine — it is a **sketch**, meaning a summary that answers a question about a stream of values approximately, in memory that does not grow with the stream. You give up exactness and get a bounded footprint. The 2.6% here is an observed error, not a promised bound on every input. Now look at the column next to it, a primary key with 200,000 rows and 200,000 distinct values, and read off its list of most common values:

```
K: ndv=200000 mcvTop=["199999","199926","199998"] mcvFreq=[0.005,0.005,0.005]
```

The engine believes each of the top three values accounts for **0.5% of the table** — a thousand rows each — in a column where every value appears exactly once. The distinct count is off by 2.6%; the frequency estimate is off by a factor of a thousand.

Both numbers come from the same single-pass scan. By the end of this chapter you will know which sketch produced each, why one degrades gracefully and the other does not, and what the optimizer does with the answers.

## One scan, four accumulators

[`StatisticsCollector.collect`](../../src/catalog/statistics.ts) reads a table once. For every column it builds a [`ColumnAccumulator`](../../src/catalog/statistics.ts) holding four running summaries plus a handful of scalars:

```typescript
distinct: new HyperLogLog(Config.statsHllPrecision),
frequent: new SpaceSavingCounter(Config.statsMcvCount * Config.statsMcvOversample),
sample: new ReservoirSample<number>(Config.statsSampleRows, deterministicRandom(index + 1)),
```

plus null count, non-null count, running min and max, and total width. [`observe`](../../src/catalog/statistics.ts) feeds one value into all of them:

```typescript
acc.nonNullCount++;
acc.distinct.addHash(hashValue(value));
acc.frequent.add(String(value));
acc.totalWidth += valueWidth(value);
...
if (acc.numeric) {
  const numeric = toNumericValue(value);
  if (numeric !== null) acc.sample.offer(numeric);
}
```

The single-pass constraint is what dictates every structure here. None of them can revisit a value, sort the column, or grow with the data. Everything is bounded by a configuration constant.

## Counting distinct values

[`HyperLogLog`](../../src/catalog/hyperloglog.ts) is 45 lines. `statsHllPrecision` is 14, so it holds `2^14 = 16,384` single-byte registers — 16 KB per column regardless of table size.

Each value is hashed to 32 bits. The top 14 bits pick a register; the remaining bits are scanned for their leading-zero run, and the register keeps the maximum run it has seen:

```typescript
addHash(hash: number): void {
  const index = hash >>> (32 - this.precision);
  const remainder = (hash << this.precision) >>> 0;
  const rank = remainder === 0 ? 33 - this.precision : Math.clz32(remainder) + 1;
  if (rank > this.registers[index]) this.registers[index] = rank;
}
```

The intuition: in a stream of random bits, a leading run of *k* zeros shows up about once every `2^k` values, so the longest run you have seen is evidence about how many *different* values there were. One register is a terrible estimator; 16,384 of them, combined by harmonic mean and a bias constant from [`alphaFor`](../../src/catalog/hyperloglog.ts), are a good one. `estimate` also applies two corrections — linear counting when many registers are still empty, and a large-range correction near `2^32`.

Measured against known inputs:

```
true=10       estimate=10        error=0.00%
true=100      estimate=100       error=0.00%
true=1000     estimate=1026      error=2.60%
true=10000    estimate=10352     error=3.52%
true=100000   estimate=101716    error=1.72%
true=1000000  estimate=986838    error=-1.32%
```

The first two rounded estimates happen to be exact in this sample. Linear counting improves behavior at small cardinalities, but is still an estimator. Error depends on hashing, precision, and the input; this table does not establish a worst-case bound.

One clamp is applied afterwards, in [`finishColumn`](../../src/catalog/statistics.ts):

```typescript
const ndv = Math.max(0, Math.min(acc.distinct.estimate(), acc.nonNullCount));
```

The count of distinct values can never exceed the number of values, so an over-estimate on a unique key is capped at the row count and is exact in this over-estimating case. A unique key whose estimate is too low remains underestimated.

## The frequency sketch, and where it lies

[`SpaceSavingCounter`](../../src/catalog/space-saving.ts) tracks the most frequent values in bounded memory. Its capacity is `statsMcvCount * statsMcvOversample` = 10 × 20 = 200 slots, kept as a min-heap on count. When a new value arrives and the heap is full:

```typescript
this.positions.delete(this.values[0]);
this.values[0] = value;
this.counts[0]++;
this.positions.set(value, 0);
this.siftDown(0);
```

The least frequent tracked value is evicted, and **the new value inherits its count plus one**. That is the Space-Saving algorithm's core trick, and it is what gives the guarantee: a value's recorded count is never lower than its true count, and the over-count is bounded by the smallest count in the heap. Anything genuinely frequent will be in the heap with an accurate count.

On a skewed stream it works exactly as advertised. One value appearing 40,000 times among 200,000:

```
top 3 = [{"value":"HOT","count":40000},{"value":"v199997","count":805},{"value":"v199996","count":805}]
```

`HOT` is counted exactly. The noise around it carries an inherited count of 805, which is the bound doing its job.

On a stream with *no* frequent values, the same mechanism produces the opening surprise. Every value is new, every insert evicts and inherits, and after 200,000 distinct values through 200 slots each survivor carries a count of about 200,000 / 200 = 1,000:

```
unique stream, capacity 200: top 3 = [{"value":"v199999","count":1000},{"value":"v199926","count":1000},{"value":"v199998","count":1000}]
```

[`buildMcv`](../../src/catalog/statistics.ts) then divides by the non-null count and records a frequency of 0.005 for each. The over-count guarantee is intact — 1,000 really is an upper bound on 1 — but the *bound* is now the whole answer, and nothing in the pipeline knows to discount it.

This matters because [chapter 23](23-cardinality-estimation.md) checks the MCV list first when estimating an equality predicate: a literal found in the list uses its recorded frequency directly. On a unique column, an equality on one of those ten values is estimated at 0.5% of the table instead of one row.

## Histograms from a sample

Min and max bound a column but say nothing about its shape. For that the collector keeps a [`ReservoirSample`](../../src/catalog/reservoir-sample.ts) of `statsSampleRows` = 30,000 numeric values:

```typescript
offer(item: T): void {
  this.seen++;
  if (this.items.length < this.capacity) { this.items.push(item); return; }
  const index = Math.floor(this.random() * this.seen);
  if (index < this.capacity) this.items[index] = item;
}
```

Classic reservoir sampling: after *n* items, every one has an equal chance of being in the reservoir, and the memory never grows. The randomness is [`deterministicRandom`](../../src/catalog/reservoir-sample.ts), a seeded mulberry32 generator seeded by column index — so statistics collection is **reproducible**, which is what makes a plan regression debuggable.

[`buildEquiDepthHistogram`](../../src/catalog/statistics.ts) sorts the sample and cuts it into buckets holding equal numbers of *sampled rows*:

```typescript
const numBuckets = Math.min(Config.statsHistogramBuckets, Math.max(1, Math.floor(sorted.length / 4)));
const step = Math.max(1, Math.floor(sorted.length / numBuckets));
for (let i = 1; i <= numBuckets; i++) {
  boundaries.push(sorted[Math.min(i * step - 1, sorted.length - 1)]);
}
```

Equal-depth rather than equal-width: bucket boundaries cluster where the data is dense. It also counts distinct values per bucket in the same loop, which is what lets [`estimateEqual`](../../src/catalog/statistics.ts) divide a bucket's rows by its distinct count rather than assuming uniformity across the whole column.

A histogram over 50,000 rows:

```
numBuckets=64  totalCount=30000  lowerBound=0  first 3 boundaries=[761,1565,2346]  last=49915
estimateLessThan(25000) = 0.4976
estimateRange(0, 5000)  = 0.0984
estimateEqual(25000)    = 3.333e-5
```

Note `totalCount=30000`, not 50,000. The histogram describes the sample, and everything it returns is a **fraction**, applied to the real row count by the caller. Note also the boundaries: 64 buckets over a 50,000-wide range, so a single bucket spans roughly 780 values and [`estimateLessThan`](../../src/catalog/statistics.ts) interpolates linearly inside it.

## Correlations

Everything above is per column, and estimating `a > 5 AND b < 3` from two independent per-column numbers is where estimation classically goes wrong. So the collector keeps one more reservoir: whole rows, projected to the numeric columns.

[`computeCorrelations`](../../src/catalog/statistics.ts) runs [`pearsonCorrelation`](../../src/catalog/statistics.ts) over every pair and keeps only those clearing `statsCorrelationThreshold` = 0.3:

```
corr(A, B) = 0.9999999995973669       -- B is derived from A
corr(A, C) = null                     -- C is A scrambled; below threshold, not stored
```

Storage is symmetric: [`_correlationKey`](../../src/catalog/statistics.ts) sorts the two column names, so `getCorrelation('B','A')` returns the same number. Chapter 23 shows the one place it is read.

## What a table's statistics are

[`TableStatistics`](../../src/catalog/statistics.ts) is a row count, a map of [`ColumnStatistics`](../../src/catalog/statistics.ts), and the correlation map. The per-column record is:

| Field | From | Used for |
|---|---|---|
| `ndv` | HyperLogLog, clamped | equality selectivity, aggregate cardinality, join selectivity |
| `min`, `max` | running comparison | range selectivity without a histogram, index range fraction |
| `nullFraction` | null count / rows | `IS NULL`, and a factor on nearly every other estimate |
| `histogram` | reservoir sample, numeric columns only | range and `BETWEEN` selectivity, histogram join collision |
| `mcv` | Space-Saving top 10 | equality and `IN` selectivity, join selectivity |
| `avgWidth` | total width / non-nulls | `avgRowWidth`, and through it the spill threshold |
| `avgLength` | string length / string count | `LIKE` selectivity |

Non-numeric columns get no histogram, which is why a `VARCHAR` range predicate falls back to a constant.

## When they are collected, and when they go stale

Statistics are not collected at load time. [`compileUncached`](../../src/engine/query-engine.ts) calls `_ensureStatistics` with the tables the query touches immediately before optimizing, and [`StatisticsCache.ensure`](../../src/catalog/statistics-cache.ts) collects any that are missing. The first query over a table pays for a full scan of it; later queries do not.

Two things guard the cache. Each entry remembers the storage object and its row count:

```typescript
describesCurrentData(key: string, entry: CacheEntry): boolean {
  if (entry.source === null) return true;
  const storage = this.catalog.getTableStorage(key);
  return storage === entry.source && storage.rowCount() === entry.rowCount;
}
```

Replace a table's storage and the identity check fails; add or remove rows and the count check fails. Either way `get` returns `undefined` and the next query re-collects. A change that preserves both — the same storage object, mutated in place, with the same number of rows — is invisible to this check, and the optimizer keeps planning against the old distribution.

Every `set` and `invalidate` bumps a `generation` counter, which feeds two things: the plan cache key in [`planCacheKey`](../../src/engine/query-engine.ts), so cached plans are discarded when statistics move, and the guard in [`_ensureStatistics`](../../src/engine/query-engine.ts) that decides whether to rebuild the optimizer. That rebuild is the subject of a warning in [chapter 28](28-plan-properties-and-ablation.md).

## In the code

| Idea | Where |
|---|---|
| Single-pass collection | [`StatisticsCollector`](../../src/catalog/statistics.ts) |
| Per-column running state | [`observe`](../../src/catalog/statistics.ts), [`finishColumn`](../../src/catalog/statistics.ts) |
| Distinct-value sketch | [`HyperLogLog`](../../src/catalog/hyperloglog.ts) |
| Frequent-value sketch | [`SpaceSavingCounter`](../../src/catalog/space-saving.ts) |
| Bounded sampling | [`ReservoirSample`](../../src/catalog/reservoir-sample.ts), [`deterministicRandom`](../../src/catalog/reservoir-sample.ts) |
| Histogram construction | [`buildEquiDepthHistogram`](../../src/catalog/statistics.ts) |
| Histogram queries | [`EquiDepthHistogram`](../../src/catalog/statistics.ts) |
| Column correlation | [`computeCorrelations`](../../src/catalog/statistics.ts) |
| Caching and staleness | [`StatisticsCache`](../../src/catalog/statistics-cache.ts) |
| Collection trigger | [`_ensureStatistics`](../../src/engine/query-engine.ts) |

## Traps

**The MCV list is populated even when there are no most common values.** Space-Saving always returns its heap. A high-cardinality column gets ten arbitrary values with identical inflated frequencies, and chapter 23 believes them.

**`ndv` is exact for unique columns only because of the clamp.** `Math.min(estimate, nonNullCount)` hides an over-estimate. Under-estimates are not clamped and pass through.

**The histogram describes 30,000 sampled rows, not the table.** Its `totalCount` is the sample size. Fractions are sound; anything reading `bucketCounts` as absolute row counts is not.

**Only numeric columns get histograms.** `NUMERIC_TYPES` covers `INT32`, `INT64`, `FLOAT64`, `DECIMAL`, `DATE`, and `TIMESTAMP`. A range predicate on `VARCHAR` falls back to a constant.

**Correlations only cover four types.** `CORRELATION_TYPES` excludes `DATE` and `TIMESTAMP`, so the classic correlated pair — an order date and a ship date — is never detected.

**Statistics collection reads the whole table.** The first query touching a table pays for a full scan of every column before its plan is chosen. On a large table that cost is real and it is not shown in `EXPLAIN ANALYZE`.

## Exercises

### Understand

A statistic estimates 100 distinct values in 1,000 rows. Is that a guarantee that each value occurs ten times?

### Practice

1. **Observe.** Reproduce the HyperLogLog error table. Feed `hashValue(i)` for known counts and print the estimate. Then drop `QE_STATS_HLL_PRECISION` to 8 and rerun — how does the error scale with the register count?

2. **Observe.** Reproduce the Space-Saving artifact on a unique column, then insert one value 40,000 times and confirm its count becomes exact. At what skew does the inherited count stop dominating?

3. **Observe.** Fix the artifact. `buildMcv` has both the recorded counts and `nonNullCount`; devise a test that rejects a heap whose counts are all equal and near `nonNullCount / capacity`, then find a query whose estimate improves.

4. **Extend (optional).** Print the histogram boundaries for a column with a heavy skew — 90% of rows at one value — and explain the bucket widths you see.

5. **Extend (optional).** `deterministicRandom` seeds from the column index. Two columns with identical data therefore get *identical* samples. Construct that case, decide whether it can bias a correlation estimate, and argue your answer.

### Hints and expected observations

No. NDV gives the number of distinct values, not their frequencies, and an estimated NDV can itself be inaccurate. A hot key can dominate the table.

## Recap

- Statistics are collected in **one pass** per table, on demand, before the first query that touches it is optimized.
- Distinct counts come from a **HyperLogLog** sketch of 16,384 registers — a few percent of error, independent of table size, clamped to the row count.
- Most-common values come from a **Space-Saving** heap of 200 slots, which over-counts by a bounded amount. On a column with no frequent values that bound *is* the reported frequency, and it can be a thousand times too large.
- Histograms are **equal-depth** over a **reservoir sample** of 30,000 numeric values, with per-bucket distinct counts, and return fractions rather than counts.
- Pairwise **Pearson correlations** over a row sample are stored when they exceed 0.3, for numeric types only.
- The cache treats an entry as current while the storage object and row count are unchanged, and bumps a **generation** counter that invalidates cached plans.

Next: [chapter 23](23-cardinality-estimation.md) turns these numbers into row-count predictions, and opens with two spellings of the same query whose estimates differ by a factor of 447.
