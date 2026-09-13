# 43. Serialization and spill files

> After this chapter you will be able to follow a chunk through serialization and explain how its visible rows, encoding, and backend affect the bytes written.

## The question

Take a 2,048-row chunk — one integer column, one string column — and serialize it three ways. Once flat. Once after `encodeChunkColumns`. And once after a filter that keeps half the rows.

```
serialized flat chunk:    12337 bytes
serialized encoded chunk:  5175 bytes   ratio 0.419
--- half the rows, via selection vector ---
serialized:               17436 bytes
```

Half the data, and 3.4 times the bytes of the encoded whole. Nothing was corrupted and nothing is wrong with the answer — the filtered chunk deserializes to 1,024 correct rows. The size comes from a single line at the top of the serializer, and it is the same line that makes the format work at all.

## The chunk format

[`ChunkSerializer`](../../src/storage/serializer.ts) is twenty-seven lines. The whole of `serialize` is:

```typescript
const chunk = source.selectionVector ? source.flatten() : source;

const writer = new ByteWriter(new Uint8Array(CHUNK_HEADER_BYTES + chunkRecordBytes(chunk.columns)));
writer.u32(chunk.size);
writer.u16(chunk.columns.length);
writeChunkRecords(writer, chunk.columns);
```

A six-byte header — a row count and a column count — followed by one record per column. Note the ordering: [`chunkRecordBytes`](../../src/storage/column-codec.ts) computes the exact total *before* a single byte is written, so the buffer is allocated once at precisely the right size. There is no growing, no chunked writer, no final copy. Every codec has to be able to price itself.

And note line one. **A chunk carrying a selection vector is flattened first.** That is the answer to the opening question, and the next section is why.

### Three forms, three codecs

[`src/storage/column-codec.ts`](../../src/storage/column-codec.ts) defines `ColumnFormCodec` — a form name, a numeric id, two size functions, a writer, and a reader — and registers three of them.

`flatCodec` handles a plain `Column`. For fixed-width types it writes `length * byteWidth` bytes of the typed array. For `VARCHAR` it writes the used byte count, then the offsets, then the packed UTF-8.

`dictionaryCodec` handles a [`DictionaryColumn`](../../src/storage/dictionary-column.ts): the `Uint16Array` of indices, then the dictionary size, then each distinct string as a length-prefixed UTF-8 record. The `Map` from string to id is not written — [`DictionaryColumn.fromParts`](../../src/storage/dictionary-column.ts) sets `_dictionary` to `null` and the `dictionary` getter rebuilds it from `reverseDict` on first write. A page that is only ever read never pays for it.

`encodedCodec` handles a `Column` holding an `EncodedVector`. It writes the encoder's id byte and then delegates to the vector's own `writeTo`, and reads it back through `encoderForId`. **An encoded column stays encoded across a round trip** — it is not decoded on the way out and re-chosen on the way in:

```
encoded chunk forms: ENCODED, DICTIONARY
round-tripped forms: ENCODED, DICTIONARY  size: 2048  value(5): 5 BUILDING
```

Which codec runs is decided by [`columnFormOf`](../../src/storage/column-codec.ts), a two-line function, and the id it writes is what picks the reader back up. Every record also carries a shared header — codec id, data type id, length, a null flag, and the null bitmap when there is one — written by [`writeColumnRecord`](../../src/storage/column-codec.ts). Data types are written as small integers from a fixed table rather than as their string names, so renaming a `DataType` member does not change the format.

### Why flattening is expensive

[`flatten`](../../src/storage/chunk.ts) builds new columns containing only the selected rows — and it builds `Column` instances, unconditionally:

```typescript
const newColumns = this.columns.map(col => {
  const newCol = new Column(col.dataType, this.size);
  for (let i = 0; i < this.size; i++) {
    newCol.set(i, col.get(this.selectionVector![i]));
  }
  newCol.length = this.size;
  return newCol;
});
```

So flattening throws away both of the compact forms. An `ENCODED` integer column becomes a flat `Int32Array`. A `DictionaryColumn` becomes a flat `VARCHAR` column with offsets and packed bytes, which for 1,024 copies of one nine-character string means 9,216 bytes of text where the dictionary held one copy and 2,048 bytes of indices:

```
forms after flatten: FLAT, FLAT
```

That is the entire 17,436-byte result. Chapter 4 named `flatten` as the boundary where the engine stops being lazy; this is the price on the storage side of that boundary, and it is charged whenever a filtered chunk is written rather than consumed.

The fix is not to change the serializer. It is to notice that a spilling operator generally has a flattened chunk already, and that the ones which do not are choosing to pay this so that the format never has to encode a selection vector.

### The byte primitives

[`ByteWriter`](../../src/storage/encoding/byte-io.ts) and [`ByteReader`](../../src/storage/encoding/byte-io.ts) are a `DataView` and a cursor. Everything is little-endian by a module constant. `bytes` copies a typed array wholesale through `Uint8Array.set`, which is why writing a column is one memory copy rather than a loop.

Two members deserve attention. `utf8` writes the string *after* the length slot and only then goes back to write the length, because `TextEncoder.encodeInto` reports the byte count as a result rather than accepting it as an argument. And [`typed`](../../src/storage/encoding/byte-io.ts) — the reader's array constructor — allocates through an [`Allocator`](../../src/storage/sab-arena.ts) rather than with `new`:

```typescript
typed<T extends AnyTypedArray>(Ctor: TypedArrayCtor<T>, length: number): T {
  const view = this.allocator.acquire(Ctor, length);
  ...
}
```

That is the seam through which a deserialized page can land in a `SharedArrayBuffer` instead of on the heap — `FilePageStore` passes `columnAllocator` as its factory, and `QE_SAB_COLUMNS` decides whether that returns an arena or the heap. Chapter 46 uses it.

## Spilling

An operator that runs out of memory writes rows somewhere and reads them back later. [`src/storage/spill-manager/spill-manager.ts`](../../src/storage/spill-manager/spill-manager.ts) splits that into two interfaces so that the "somewhere" is swappable.

[`SpillStorage`](../../src/storage/spill-manager/spill-manager.ts) is byte-level: `append`, `openReader`, `exists`, `remove`, `removeAll`. It knows nothing about chunks. [`ChunkSpillStore`](../../src/storage/spill-manager/spill-manager.ts) is what operators see: `appendChunk`, `readChunks`, `clearPartition`, `clearAll`. [`SpillManager`](../../src/storage/spill-manager/spill-manager.ts) implements the second in terms of the first, and it is the only place the two meet.

The framing is a four-byte length in front of each serialized chunk:

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

Reading is the mirror image, as an async generator: read four bytes, read that many, deserialize, yield, repeat until a read returns `null`. A partition file is a stream of self-delimiting chunks with no directory and no footer, so it can be appended to at any time and read from the beginning at any time. Chapter 34's hash join relies on exactly that — it writes to a partition while the build is running and reads it back after the probe stream ends.

Two storages implement `SpillStorage`.

[`FsStorage`](../../src/storage/spill-manager/fs-storage.ts) writes `${partitionId}.spill` files in a directory. It caches one append-mode file handle per partition in a `Map<string, Promise<FileHandle>>` — the *promise*, not the handle, so concurrent appends to a new partition share one `open` rather than racing. `openReader` calls `closeWriteHandle` first, which is what guarantees a reader sees everything that was written.

[`MemoryStorage`](../../src/storage/spill-manager/memory-storage.ts) keeps a `Uint8Array[]` per partition and reads across buffer boundaries with a small splice-and-concatenate reader. Its buffers hold byte-for-byte what the file would:

```
--- memory spill ---
read back: 2 chunks, 4096 rows
buffers held: 2  bytes: 10358
...
fs spill read back rows: 4096  file exists: true
file size on disk: 10358 bytes
```

The same two chunks, the same 10,358 bytes, on either side of the interface.

## Where the files go

Neither storage picks its own directory. Both are handed one, and the thing that hands it out is a **temp space** — the third factory on a storage backend, and the subject of chapter 44.

[`TempDirectoryManager`](../../src/storage/temp-space/temp-directory-manager.ts) makes one root per engine, named for the process and a random suffix, and hands out subdirectories by category and label:

```
temp root: query_engine_18484_5i9vnmeb
spill/
  agg_3/
  join_1/
  result_0/
  topn_2/
after close(), root exists: false
```

Four operators asked for space during one query: the hash join, the top-N, the aggregate, and the result sink. Each got its own directory, named after what asked and numbered by a per-category counter. That is what makes a spilling query legible on disk — the directory names tell you which operator ran out of memory.

Two details in that listing are easy to misread. The directories are **created eagerly**, by an `fs.mkdirSync` inside [`allocate`](../../src/storage/temp-space/temp-directory-manager.ts), at the moment the pipeline is built rather than the moment anything spills. Running the same query with the default 256 MB memory limit produces exactly the same four directories, all empty. And they are empty at the end either way, because `clearAll` unlinks the `.spill` files when the operator finishes; what a post-mortem `ls` shows you is not what was there during the query.

Cleanup has three layers. `close()` on the engine calls `cleanup()`, which removes the root recursively. If the process exits without that, a module-level `process.on('exit')` hook runs `cleanup` for every live manager. And if the process dies without running hooks at all, the *next* engine to start calls [`reapStaleDirectories`](../../src/storage/temp-space/temp-directory-manager.ts), which parses the pid out of each `query_engine_<pid>_<random>` directory name and deletes the ones whose process is gone, tested with `process.kill(pid, 0)`.

[`MemoryTempSpace`](../../src/storage/temp-space/memory-temp-space.ts) is the same interface with no filesystem behind it. It hands out strings in the same shape and never creates anything:

```
spill 0: mem://query_engine/spill/hash-join-build_0
spill 1: mem://query_engine/spill/hash-join-probe_1
buffer 0: mem://query_engine/buffer/ORDERS_0
```

Those handles are opaque labels. `MemoryStorageBackend` ignores them entirely — its `createSpillManager` takes no argument and returns a fresh `MemoryStorage` each time, so isolation comes from the object rather than from the path.

## Does it agree?

Spilling is only worth anything if the spilled answer equals the resident one. Running the book's query over 20,000 customers and 80,000 orders, twice on disk and once in memory:

```
=== default limit, node ===         (memoryLimitBytes = 268435456)
  {"C_NAME":"Customer#000816","TOTAL":48924}
  {"C_NAME":"Customer#003807","TOTAL":48924}
  {"C_NAME":"Customer#006798","TOTAL":48924}
=== 64 KB limit, node ===
  (identical)
=== 64 KB limit, browser backend ===
  (identical)
```

Same rows, in the same order, whether the join and the aggregate ran entirely in memory, spilled through `.spill` files, or spilled into `Uint8Array`s.

Read the `TOTAL` column before trusting that too far. All three rows hold the same value, so `ORDER BY TOTAL DESC` does not order them with respect to each other, and which of the tied customers a `LIMIT 3` returns is a property of the physical plan rather than of the query. Lowering the memory limit changes the plan, and on a fixture with a longer tie it changes the last row with it — without changing a single sum. The equality spilling actually preserves is over the whole result, not over an arbitrary prefix of a tied one: add `C_NAME` as a second sort key, or drop the `LIMIT` and compare every group, and the three runs match row for row.

## In the code

| Idea | Where |
|---|---|
| Chunk header and layout | [`ChunkSerializer`](../../src/storage/serializer.ts) |
| Exact size before writing | [`chunkRecordBytes`](../../src/storage/column-codec.ts) |
| Which codec a column gets | [`columnFormOf`](../../src/storage/column-codec.ts) |
| Per-column header | [`writeColumnRecord`](../../src/storage/column-codec.ts) |
| The three storage forms | [`ColumnForm`](../../src/storage/column-codec.ts) |
| Cursor over a `DataView` | [`ByteWriter`](../../src/storage/encoding/byte-io.ts) |
| Reader allocation seam | [`typed`](../../src/storage/encoding/byte-io.ts) |
| Byte-level spill contract | [`SpillStorage`](../../src/storage/spill-manager/spill-manager.ts) |
| Chunk-level spill contract | [`ChunkSpillStore`](../../src/storage/spill-manager/spill-manager.ts) |
| Length-prefixed framing | [`SpillManager`](../../src/storage/spill-manager/spill-manager.ts) |
| `.spill` files and handle caching | [`FsStorage`](../../src/storage/spill-manager/fs-storage.ts) |
| Buffer lists | [`MemoryStorage`](../../src/storage/spill-manager/memory-storage.ts) |
| Directories per operator | [`TempDirectoryManager`](../../src/storage/temp-space/temp-directory-manager.ts) |
| Labels instead of directories | [`MemoryTempSpace`](../../src/storage/temp-space/memory-temp-space.ts) |
| File suffixes | [`src/storage/storage-constants.ts`](../../src/storage/storage-constants.ts) |

## Traps

**A zero-row chunk writes nothing, and the partition then does not exist.** `appendChunk` returns early on `!chunk || chunk.size === 0`, so `hasSpilled` stays false and `readChunks` yields nothing rather than yielding an empty chunk. An operator that treats "no partition" as "not spilled" is right; one that treats it as "zero rows written" is also right, and the two only differ if something else already decided the partition existed.

**Spilling under the memory backend does not free memory.** `MemoryStorage` holds the serialized bytes in a `Map`. Spilling still helps — the bytes are typically much smaller than the live columns, and the operator's working set shrinks to one partition — but the process footprint does not drop the way it does with `FsStorage`. The browser backend supplied here keeps these bytes in memory; a browser storage backend using persistent APIs would be a separate design.

**`removeAll` only deletes `.spill` files.** It filters `readdir` output by suffix, so anything else in a spill directory survives. Directory removal is the temp manager's job, not the storage's.

**The serialized size is not the retained size.** `columnRecordBytes` prices what will be written; `columnRetainedBytes` prices what is held in memory, including over-allocated capacity. A flat `VARCHAR` column whose byte buffer doubled to 32 KB for 25 KB of text retains more than it serializes, and chapter 41's dictionary comparison flips sign depending on which you measure.

**Little-endian is assumed, not recorded.** No byte-order mark is written. The format assumes compatible byte order at both ends. Common deployment targets are little-endian, but the format does not detect an incompatible target.

**A tied `ORDER BY` key makes the top rows a property of the plan.** `ORDER BY TOTAL DESC LIMIT 3` over a result where several groups share a total returns three of them, not a defined three. Spilling changes the plan, so it can change which three while every sum stays identical. A comparison like the one above tests the tiebreak as much as the spill unless the sort key is made unique or the `LIMIT` is dropped.

## Recap

- A serialized chunk is a **six-byte header plus one record per column**, and the exact size is computed by the codecs before any byte is written so the buffer is allocated once.
- There are **three column forms** — flat, dictionary, encoded — each with an id written into the record, so an encoded column stays encoded across a round trip.
- `ChunkSerializer` **flattens a chunk carrying a selection vector**, and `flatten` builds plain `Column`s. That discards both the integer encoding and the dictionary, which is why half a chunk can serialize to three times the whole one.
- Spilling is split into a **byte-level `SpillStorage`** and a **chunk-level `ChunkSpillStore`**, joined by `SpillManager`, which frames each chunk with a four-byte length. Files and memory buffers hold identical bytes.
- A **temp space** hands out one directory per spilling operator, named after it, created eagerly and removed on `close()`, on process exit, or by the next engine that finds it orphaned.

Next: [chapter 44](44-storage-backends.md) asks who chooses between `FsStorage` and `MemoryStorage`, and shows that the answer is one line in each of two entry points — which is the whole reason this engine runs in a browser.
