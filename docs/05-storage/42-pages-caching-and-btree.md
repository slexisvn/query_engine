# 42. Pages, caching, and the B-tree

> After this chapter you will know what a page is in this engine, why the page cache has a cliff at exactly its own capacity, why the scan path steps around that cliff by never using the cache at all, and how a B-tree turns a `WHERE` clause into six row addresses.

## The question

Build a table of 50 pages and read it three times through `scanAll`, counting reads that reach the page store. Then build one of 51 pages and do the same.

```
{"pages":50,"cacheLimit":50,"cached":50,"readsOnTwoMoreScans":0}
{"pages":51,"cacheLimit":50,"cached":50,"readsOnTwoMoreScans":102}
```

Fifty pages: warm, zero reads. Fifty-one pages: every page misses on every scan, forever. One extra page took the hit rate from 100% to 0%.

That is a famous pathology, and this engine's response to it is more interesting than the pathology. The scan path does not tune the cache, or switch eviction policies, or add a scan-resistant admission rule. It **stops using the cache**.

## A page is a chunk with a name

[`PageStore`](../../src/storage/page-cache.ts) is three methods:

```typescript
export interface PageStore {
  write(pageId: string, chunk: DataChunk): Promise<void>;
  read(pageId: string): Promise<DataChunk | null>;
  clear(): void;
}
```

A page is a `DataChunk` and an identifier. There is no fixed page size, no header, no free-space map, no page-level checksum — the unit of storage is exactly the unit of execution, so nothing has to be reassembled on the way in or split on the way out. `Table` names pages by counting, as chapter 40 showed, and the store treats the name as an opaque key.

Two stores implement it. [`MemoryPageStore`](../../src/storage/page-store/memory-page-store.ts) is a `Map<string, DataChunk>` and twenty-two lines long — `write` is a `Map.set`, so the chunk it hands back later is the same object it was given. [`FilePageStore`](../../src/storage/page-store/file-page-store.ts) runs the chunk through [`ChunkSerializer`](../../src/storage/serializer.ts) and writes `${pageId}.qdat` under a directory it was handed at construction; a read parses the file back into a fresh chunk. Which one you get is decided in chapter 44.

The serialization difference has a consequence worth naming now: with `MemoryPageStore` a page read is free and returns shared arrays; with `FilePageStore` it is a file read plus a parse and returns arrays nobody else holds. Everything above them is written to be indifferent, which is why they can be swapped.

## The cache

[`PageCache`](../../src/storage/page-cache.ts) wraps a store with an [`LRUCache`](../../src/utils/lru-cache.ts) of at most `Config.pageCachePages` entries, 50 by default and settable with `QE_PAGE_CACHE_PAGES`.

The LRU is the textbook structure: a `Map` from key to node, plus a doubly-linked list ordered by recency. `get` moves a node to the head; `set` prepends and, if the map is now over capacity, drops the tail and returns the evicted key so a caller can react:

```javascript
--- LRU maxSize 3 ---
evicted on set(d): b  keys now: a,c,d
```

Three keys `a`, `b`, `c` were inserted, then `a` was read. Inserting `d` evicted `b` — the least recently used — not `a`, which was inserted first.

Recency is exactly the wrong thing to optimize for when the access pattern is a full sequential scan of more pages than fit. The page you are least likely to need soon is the one you read most recently; the page you will need soonest is the one evicted longest ago. LRU inverts that, so a scan of *N* + 1 pages through a cache of *N* misses on every page of every pass. The 51-page measurement above is that inversion, exactly.

### Why the scan path opts out

[`fetchPage`](../../src/storage/page-cache.ts) takes a flag:

```typescript
async fetchPage(pageId: string, bypassCache = false): Promise<DataChunk | null> {
  const cached = this.cache.get(pageId);
  if (cached !== undefined) return cached;

  const chunk = await this.readPage(pageId);
  if (bypassCache) return chunk;

  this.cache.set(pageId, chunk);
  return chunk;
}
```

`bypassCache` does not skip the lookup — a page that happens to be resident is still served from memory. It skips the *insert*. A bypassing read cannot evict anything, and cannot pollute the cache with pages that will not be wanted again.

Every call site on the query path passes `true`. [`Table.scan`](../../src/storage/table.ts) does, [`IndexScanOperator`](../../src/execution/operators/index-scan.ts) does, and so does index construction in [`buildIndexes`](../../src/engine/query-engine.ts) and the visualizer's loader. The one call that passes `false` is [`Table.scanAll`](../../src/storage/table.ts), which nothing on the query path reaches — [`ScanOperator`](../../src/execution/operators/scan.ts) only ever calls `scan`.

So the honest description of the current code is this: **the LRU inside `PageCache` is never populated during query execution.** It is not dead — `PageCache` is still the single door to the page store, `writePage` goes through it, and `clear` tears down both layers together — but its caching behavior only runs under `scanAll`, and that is reached from tests. Measured on a 100-page table:

```
--- after one full scan() ---
rows seen: 204800  store reads: 100  cache entries: 0
--- after a second full scan() ---
rows seen: 204800  store reads: 100  cache entries: 0
--- after scanAll() ---
chunks: 100  store reads: 100  cache entries: 50  maxPages: 50
```

Under `MemoryPageStore` this costs nothing, because a "read" is a `Map` lookup. Under `FilePageStore` it means every full scan re-reads and re-parses every page — deliberately, in exchange for a bounded and predictable memory footprint, and for the property that a large scan cannot evict the pages an index scan is using.

## The B-tree

A scan reads every page. The alternative is knowing which page to read, which is [`BTreeIndex`](../../src/storage/btree.ts) — a B+ tree from a key to a list of row addresses:

```typescript
export interface RowLocation {
  pageId: string;
  rowIndex: number;
}
```

A page identifier and an offset within it. Nothing else — no version, no tuple identifier, no back pointer — which is workable because pages here are append-only and rows never move.

Internal nodes hold keys and children; leaves hold keys, a parallel array of `RowLocation[]`, and a `next` pointer to the following leaf. `_findIndex` and `_findChildIndex` are both binary searches, differing only in whether an equal key goes left or right. A node splits when it reaches `Config.btreeOrder` keys, 128 by default and settable with `QE_BTREE_ORDER`:

```
order    4  depth 10  nodes  29999  leaves  20000  root keys 2
order   16  depth  5  nodes   5623  leaves   5000  root keys 5
order  128  depth  3  nodes    635  leaves    625  root keys 8
order 1024  depth  2  nodes     79  leaves     78  root keys 77
```

Forty thousand keys, four fanouts. Depth falls logarithmically while node count falls linearly, and both matter: depth is how many binary searches a lookup does, node count is how many objects the index costs. Order 128 is the usual disk-oriented compromise, and here — where every node is a JavaScript object on the heap rather than a disk block — it is doing the second job more than the first.

The `next` chain is what makes range scans cheap. [`range`](../../src/storage/btree.ts) descends once to the leaf containing the low bound, then walks leaves sideways, yielding locations until a key exceeds the high bound. It never returns to the root.

### From a predicate to an index scan

Three pieces connect a `WHERE` clause to that structure.

[`buildIndexes`](../../src/engine/query-engine.ts) builds the trees. For every table whose catalog entry declares a primary key, it flushes the table, walks each page, and inserts one key per non-null value. Once a tree exists, `Table.addChunk` keeps it current — every subsequent page feeds all registered indexes as it is sealed.

[`IndexSelection`](../../src/optimizer/passes/index-selection.ts) decides whether to use one. It collects the bounds each conjunct puts on each column, looks for an index on that column, and — when statistics are available — estimates how much of the table the bounds select:

```typescript
if (selectivity > Config.indexScanSelectivityThreshold) continue;
```

Above 0.3, the index is skipped in favor of a sequential scan, because fetching 40% of the rows one address at a time is slower than reading every page in order. Conjuncts the index consumes are removed; whatever is left becomes a `Filter` above the index scan.

[`IndexScanOperator`](../../src/execution/operators/index-scan.ts) executes it. It resolves the tree to a list of `RowLocation`s, then does the thing that makes this worth doing:

```typescript
const pageGroups = new Map<string, number[]>();
for (const loc of locations) {
  let group = pageGroups.get(loc.pageId);
  if (!group) { group = []; pageGroups.set(loc.pageId, group); }
  group.push(loc.rowIndex);
}
```

Locations are grouped by page before anything is fetched, so each page is read at most once no matter how many matching rows it holds. Rows are then assembled into chunks of `Config.flushBatchSize` — which is where the columnar layout is abandoned and rebuilt, one value at a time, the same cost chapter 34 called out for hash joins.

Real output over a 40,000-row, 20-page table with an index on `O_ORDERKEY`:

```
-> Project (ORDERS.O_CUSTKEY)
  -> Index Scan using IDX_ORDERS_O_ORDERKEY on ORDERS (key: 33333)

Physical Plan:
Project
  IndexScan
```

```
-> Project (ORDERS.O_CUSTKEY)
  -> Index Scan using IDX_ORDERS_O_ORDERKEY on ORDERS (range: 100 to 105)
```

```
-> Project (ORDERS.O_CUSTKEY)
  -> Index Scan using IDX_ORDERS_O_ORDERKEY on ORDERS (range: 39990 to ∞)
```

An unbounded side prints as `∞` and is passed to `range` as `null`, which the descent treats as "start at the leftmost leaf" or "never stop". A predicate on a column with no index falls back:

```
-> Project (ORDERS.O_CUSTKEY)
  -> Filter (condition: (ORDERS.O_CUSTKEY = 7))
    -> Seq Scan on ORDERS as ORDERS
```

## In the code

| Idea | Where |
|---|---|
| The store contract | [`PageStore`](../../src/storage/page-cache.ts) |
| Pages as a `Map` | [`MemoryPageStore`](../../src/storage/page-store/memory-page-store.ts) |
| Pages as `.qdat` files | [`FilePageStore`](../../src/storage/page-store/file-page-store.ts) |
| Cache in front of a store | [`PageCache`](../../src/storage/page-cache.ts) |
| The read that may not insert | [`fetchPage`](../../src/storage/page-cache.ts) |
| Map plus doubly-linked list | [`LRUCache`](../../src/utils/lru-cache.ts) |
| The index | [`BTreeIndex`](../../src/storage/btree.ts) |
| A key's answer | [`RowLocation`](../../src/storage/btree.ts) |
| Leaf-to-leaf range walk | [`range`](../../src/storage/btree.ts) |
| Building trees from pages | [`buildIndexes`](../../src/engine/query-engine.ts) |
| Deciding to use one | [`IndexSelection`](../../src/optimizer/passes/index-selection.ts) |
| Running one | [`IndexScanOperator`](../../src/execution/operators/index-scan.ts) |

| Setting | Default | Effect |
|---|---|---|
| `pageCachePages` | 50 | LRU capacity, per table |
| `btreeOrder` | 128 | keys per node before a split |
| `indexScanSelectivityThreshold` | 0.3 | selectivity above which the index is not used |
| `flushBatchSize` | 2048 | rows per chunk emitted by an index scan |

## Traps

**An index only sees pages sealed after it was registered.** `addChunk` feeds `this.indexes`; nothing back-fills. Registering a tree on a table that already has rows leaves it empty, and the tree does not complain:

```
--- index registered after insert ---
search(7): []

--- index registered before insert ---
search(7): [{"pageId":"ORDERS2_page_0","rowIndex":7}]
```

`buildIndexes` gets this right by walking the existing pages itself before handing the tree to `registerIndex`.

**Every table has its own `PageCache`.** It is constructed in the `Table` constructor, so `QE_PAGE_CACHE_PAGES=50` is a per-table budget, not a global one. Ten tables can hold 500 pages.

**`_compare` converts `bigint` keys through `Number`.** Two `INT64` keys that differ above 2⁵³ become the same key:

```
--- INT64 keys 2^53 and 2^53+1 ---
search(2^53):   [{"pageId":"p","rowIndex":1},{"pageId":"p","rowIndex":2}]
search(2^53+1): [{"pageId":"p","rowIndex":1},{"pageId":"p","rowIndex":2}]
distinct leaf keys stored: 1
```

Both rows come back for both lookups. A point lookup that returns extra rows is only safe because `IndexSelection` leaves a residual `Filter` when it cannot consume a conjunct — but a conjunct it *does* consume is not re-checked, so this is a genuine limit on `BIGINT` keys, not a conservative one.

**`BETWEEN` does not reach the index, but `>=` and `<=` do.** `_analyzeConjunct` accepts a binary node whose operator is one of `=`, `>`, `>=`, `<`, `<=` and whose sides are a column reference and a literal. A `BETWEEN` is none of those, so `WHERE k BETWEEN 100 AND 105` plans a sequential scan while the identical `k >= 100 AND k <= 105` plans a range scan, and [`ExpressionSimplifier`](../../src/optimizer/passes/expression-simplifier.ts) does not rewrite one into the other.

**`clear()` on a `PageCache` deletes the data.** It empties the LRU *and* calls `pageStore.clear()`, which for `FilePageStore` is a recursive `rmSync` of the directory. It is not a cache-drop.

## Exercises

1. Reproduce the cliff. Build tables of 49, 50, and 51 pages, call `scanAll` three times on each, and count reads that reach the store. Then set `QE_PAGE_CACHE_PAGES=51` and confirm the cliff moves.

2. `fetchPage` checks the cache even when bypassing. Construct a sequence of calls in which that lookup returns a hit during a `scan`, and say which code path put the page there.

3. Insert 40,000 keys into a `BTreeIndex` at `QE_BTREE_ORDER` of 4, 16, 128, and 1,024, and print the depth and node count. At which order does a point lookup do the fewest total comparisons, and why is that not the same as the fastest?

4. Make the sequential scan populate the cache: change the `true` in `Table.scan` to `false`. Measure a repeated scan of a 40-page table and a 60-page table with `FilePageStore`. Explain both results.

5. Add most-recently-used eviction as an option to `LRUCache` and use it for scans. Does it fix the 51-page case? What does it break for the index scan?

## Recap

- A **page** is a `DataChunk` plus a string identifier. There is no page format above the chunk format, and the store is a `Map` or a directory of `.qdat` files.
- [`PageCache`](../../src/storage/page-cache.ts) puts an **LRU** in front of the store, but `fetchPage`'s `bypassCache` flag skips the insert — and every call on the query path sets it. The LRU is never populated while a query runs.
- LRU is the wrong policy for a full scan: a scan of one more page than fits misses on **every page of every pass**, measured as 0 reads at 50 pages and 102 at 51.
- A **B+ tree** maps a key to `{pageId, rowIndex}` addresses, with leaves chained for range walks. `btreeOrder` trades depth against node count.
- An index is used only when the optimizer's selectivity estimate is at or below **`indexScanSelectivityThreshold`**, and the operator **groups locations by page** so each page is read once.

Next: [chapter 43](43-serialization-and-spill.md) opens the `.qdat` file — the byte format a page is written in, the spill files that reuse it, and the temporary directories they live in.
