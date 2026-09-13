# 40. Columnar tables

> After this chapter you will be able to compare InMemoryRelation with paged Table storage and trace a row batch through insertion, encoding, and scanning.

## The question

Load 2,048 orders into the engine two ways. First through the DataFrame path, which hands an array of objects to `registerTable`. Then through SQL, with `CREATE TABLE` followed by `insertRows`. Both answer every query identically. Ask each what it is holding:

```
InMemoryRelation chunk forms : FLAT, FLAT, DICTIONARY
InMemoryRelation retained    : 8448 + 8448 + 4367 = 21263
Table chunk forms            : ENCODED, ENCODED, DICTIONARY
Table retained               : 3077 + 3077 + 4367 = 10521
```

Same rows, same schema, same chunk size, half the bytes. Nothing in either call asked for compression. The difference is not a setting — it is which of two classes you ended up with, and what that class does at the moment a chunk fills up.

## Two storages, one interface

[`src/storage/table-storage.ts`](../../src/storage/table-storage.ts) declares what an operator is allowed to assume about a table. It is five methods:

```typescript
export interface TableStorage {
  getSchema(): ColumnSchema[];
  rowCount(): number;
  getColumnIndex(columnName: string): number;
  scan(pruner?: ChunkPruner | null): AsyncGenerator<DataChunk>;
  scanAll(): Promise<DataChunk[]>;
}
```

That is the entire contract between execution and storage. [`ScanOperator`](../../src/execution/operators/scan.ts) declares an even narrower structural type of its own — four of the five, dropping `getColumnIndex` — and on the data path calls only `scan`, in a `for await` loop. It does not know whether the chunks it receives came from a file, a `Map`, or an array that has been sitting in memory since startup.

Two classes implement the interface.

[`InMemoryRelation`](../../src/dataframe/in-memory-relation.ts) is an array of `DataChunk`s and a schema. It is what `registerTable`, `registerStreamingTable`, and every DataFrame produce.

[`Table`](../../src/storage/table.ts) is what `CREATE TABLE` produces. It keeps no chunks. It keeps a list of page identifiers, a zone map per page, a row count, and a [`PageCache`](../../src/storage/page-cache.ts) pointed at a page store.

A second interface, [`PagedTableStorage`](../../src/storage/table-storage.ts), describes what `Table` has and `InMemoryRelation` does not — `pageIds`, `pageCache`, `indexes`, `insertRows`, `flush`, `registerIndex`. Code that needs those narrows with a one-line guard:

```typescript
export function isPagedTableStorage(storage: TableStorage): storage is PagedTableStorage {
  return Array.isArray((storage as PagedTableStorage).pageIds);
}
```

The guard is a duck-typing check on a single property rather than an `instanceof`, which is what lets a test double or a wrapper stand in for a real table. Index scans need it — [`buildIndexScan`](../../src/execution/builders/source-builders.ts) refuses to plan without paged storage — and so does the engine's index construction. A sequential scan never asks.

## InMemoryRelation: rows in, chunks out

The whole of the conversion is [`buildChunks`](../../src/dataframe/in-memory-relation.ts):

```typescript
let chunk = DataChunk.fromSchema(schema, DEFAULT_CHUNK_SIZE);
for (const values of rowValues) {
  if (chunk.size >= DEFAULT_CHUNK_SIZE) {
    chunks.push(chunk);
    chunk = DataChunk.fromSchema(schema, DEFAULT_CHUNK_SIZE);
  }
  chunk.appendRow(values);
}
```

Fill a chunk to 2,048 rows, start another. Five thousand rows come out as the boundaries we saw in [chapter 4](../00-orientation/04-rows-columns-and-chunks.md):

```
relation chunks: 3 sizes: 2048, 2048, 904
column classes: Column, DictionaryColumn, DictionaryColumn
```

When no schema is supplied, [`inferColumnType`](../../src/dataframe/type-inference.ts) picks one per column from the values, and [`coerceForColumn`](../../src/dataframe/type-inference.ts) converts each cell to fit. That is the only transformation. `DataChunk.fromSchema` already chooses `DictionaryColumn` for `VARCHAR`, so the string columns arrive dictionary-encoded; the integer column stays a plain `Int32Array`. Nothing else happens to the data.

Zone maps — the per-chunk minimum and maximum used to skip chunks that cannot match a predicate — are built lazily and only when a pruner is actually supplied:

```javascript
_zoneMaps before scan: null
_zoneMaps after a pruner-less scan: null
```

`scan()` with no pruner yields `this.chunks` directly, by `yield*`. Two scans of the same relation hand out the identical objects:

```
relation: same chunk object across two scans? true
```

That is fine because operators build fresh chunks for their output rather than writing into their input — [`FilterOperator`](../../src/execution/operators/filter.ts) constructs `new DataChunk(chunk.columns, count)` and puts the selection vector on the *new* chunk, sharing the columns by reference. But it means an `InMemoryRelation` is exactly as durable as the arrays you handed it, and no more.

## Table: rows in, pages out

[`insertRows`](../../src/storage/table.ts) does not write anything. It appends into a single `activeChunk` and seals that chunk only when the next row arrives to find it full:

```typescript
for (const row of rows) {
  if (this.activeChunk.size >= DEFAULT_CHUNK_SIZE) {
    await this.addChunk(this.activeChunk);
    this.activeChunk = this._createChunk();
  }
  this.activeChunk.appendRow(row);
}
```

So inserting exactly 5,000 rows leaves two sealed pages and 904 rows in limbo:

```
table.rowCount(): 5000
table.pageIds.length: 2
table._rowCount: 4096
activeChunk.size: 904
```

`rowCount()` covers the discrepancy by adding `activeChunk.size` to `_rowCount`, so the count is always right even though the storage is not yet complete. Insert one more row and the page count does not move — the tail chunk has room. What moves it is a read. Both `scan` and `scanAll` begin with `await this.flush()`, and `flush` seals whatever is left:

```
--- after scan() ---
scan chunk sizes: 2048, 2048, 905
pageIds.length: 3 activeChunk: null
pageIds: CUSTOMER_page_0, CUSTOMER_page_1, CUSTOMER_page_2
```

Page identifiers are `${tableName}_page_${index}` — a string, generated by counting, never parsed. Everything below `Table` treats it as an opaque key.

### What sealing a chunk costs

[`addChunk`](../../src/storage/table.ts) is the only place in the engine where a chunk becomes storage, and the whole of it is six lines and a loop over the registered indexes:

```typescript
const stored = encodeChunkColumns(chunk);
const pageId = `${this.name}_page_${this.pageIds.length}`;
this.pageIds.push(pageId);
this.zoneMaps.push(buildChunkZoneMap(stored));
this._rowCount += stored.size;
await this.pageCache.writePage(pageId, stored);
```

[`encodeChunkColumns`](../../src/storage/encoding/column-encoding.ts) is the answer to the opening question. It replaces every integer column that compresses well with an encoded one, and returns a **different chunk** — the one you passed in is untouched. That is why the SQL table's `O_ORDERKEY` and `O_CUSTKEY` come back as `ENCODED` while the relation's stay `FLAT`, and why the two differ by 10,742 bytes on 2,048 rows. Chapter 41 is entirely about that function.

[`buildChunkZoneMap`](../../src/storage/zone-map.ts) walks each column once and records a minimum, a maximum, and whether any nulls were seen — eagerly, at write time, unlike `InMemoryRelation`:

```
zoneMaps[0].columns[0].range: {"min":0,"max":2047}
zoneMaps[2].columns[0].range: {"min":4096,"max":5000}
zoneMaps[0].columns[2].range: {"min":"BUILDING","max":"MACHINERY"}
```

`writePage` goes straight to the page store, and the loop that follows feeds every registered B-tree index with a `{ pageId, rowIndex }` for each non-null key. Both of those belong to chapter 42.

Two things `addChunk` does *not* do are worth naming. It does not deduplicate, sort, or index the rows on its own, and it does not update statistics — [`getStatistics`](../../src/storage/table.ts) on `Table` returns `null` unconditionally, and the optimizer's statistics come from a separate sampling path covered in chapter 22.

## Reading a table back

`Table.scan` is a generator over page identifiers:

```typescript
for (let i = 0; i < this.pageIds.length; i++) {
  if (pruner && pruner.canSkip(this.zoneMaps[i])) continue;
  const chunk = await this.pageCache.fetchPage(this.pageIds[i], true);
  yield (chunk as DataChunk).scanView();
}
```

Three things happen per page. The zone map is consulted first, so a pruned page is never fetched at all — that is chapter 32's subject, and it is the reason zone maps are built at write time rather than on demand. The fetch passes `true` for `bypassCache`, which turns out to matter a great deal; chapter 42 explains why. And [`scanView`](../../src/storage/chunk.ts) wraps the result rather than returning it:

```
same chunk object across two scans? false  same columns object? false
```

A scan view is a new `DataChunk` holding new `Column` objects that point at the same typed arrays. It costs one small allocation per column and buys each scan its own `size`, its own `selectionVector`, and its own `length` fields. Two concurrent scans of one table cannot interfere through those.

Above the scan, [`project`](../../src/storage/chunk.ts) drops the columns the query does not read, by reference and without copying. A nine-column `ORDERS` page read by a query that mentions two columns yields a two-column chunk over the same arrays.

## In the code

| Idea | Where |
|---|---|
| What execution assumes about a table | [`TableStorage`](../../src/storage/table-storage.ts) |
| The extra surface a paged table has | [`PagedTableStorage`](../../src/storage/table-storage.ts) |
| Narrowing to it | [`isPagedTableStorage`](../../src/storage/table-storage.ts) |
| Chunks held in memory | [`InMemoryRelation`](../../src/dataframe/in-memory-relation.ts) |
| Rows to chunks | [`buildChunks`](../../src/dataframe/in-memory-relation.ts) |
| Pages written through a cache | [`Table`](../../src/storage/table.ts) |
| Buffering rows until a chunk fills | [`insertRows`](../../src/storage/table.ts) |
| Sealing a chunk into a page | [`addChunk`](../../src/storage/table.ts) |
| Compressing on the way in | [`encodeChunkColumns`](../../src/storage/encoding/column-encoding.ts) |
| Per-page min/max | [`buildChunkZoneMap`](../../src/storage/zone-map.ts) |
| Per-scan view over shared arrays | [`scanView`](../../src/storage/chunk.ts) |
| The only operator that reads a table | [`ScanOperator`](../../src/execution/operators/scan.ts) |

## Traps

**`rowCount()` and `pageIds.length` disagree until something reads the table.** The tail chunk lives in `activeChunk` and is counted but not stored. Code that walks `pageIds` directly — index construction in [`buildIndexes`](../../src/engine/query-engine.ts) does, and so does the visualizer's loader — must `await storage.flush()` first, and both do.

**The chunk you hand to `addChunk` is not the chunk that gets stored.** `encodeChunkColumns` returns a new `DataChunk` when anything was encoded, and `Table` keeps that one. Holding a reference to the chunk you inserted tells you nothing about what is on the page.

**Only `Table` compresses.** A DataFrame, a `registerTable` call, and every intermediate result stay in whatever form the producing operator built. Encoding is a property of writing a page, not a property of a column.

**`scanAll` exists but nothing on the query path calls it.** Execution reaches storage only through `scan`. `scanAll` is reachable from the `TableStorage` interface and used by tests; treating it as the bulk-read fast path would be reading intent into the code rather than behavior.

**`getColumnIndex` compares uppercased names.** Both implementations uppercase both sides. A schema with columns differing only in case cannot be addressed, and the binder's normalization is what keeps that from mattering.

## Recap

- Execution talks to storage through **`TableStorage`**, five methods wide, and the only one a sequential scan uses is `scan`.
- **`InMemoryRelation`** holds `DataChunk`s in an array and changes nothing about them; it is what DataFrames and `registerTable` produce.
- **`Table`** holds page identifiers and a page cache; it is what `CREATE TABLE` produces. Rows accumulate in an **`activeChunk`** and become a page only when the chunk fills or something reads the table.
- **`addChunk`** is where a chunk becomes storage: it encodes the columns, names the page, builds the **zone map**, writes through the page cache, and feeds the indexes.
- Compression is a consequence of writing a page, not a property of a chunk — which is why the same rows retain 21,263 bytes in a relation and 10,521 in a table.

Next: [chapter 41](41-encodings.md) opens `encodeChunkColumns` and works out which of three encodings each column gets, and why the column that looks most compressible gets the worst ratio in the table.
