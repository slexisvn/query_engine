# 4. Rows, columns, and chunks

> After this chapter you will know the one data structure every operator in this engine manipulates, why it stores columns instead of rows, and why it moves 2,048 of them at a time.

## The question

A table is rows. A query result is rows. So the obvious representation is an array of objects:

```javascript
[
  { C_CUSTKEY: 1, C_NAME: 'Alice', C_MKTSEGMENT: 'BUILDING' },
  { C_CUSTKEY: 2, C_NAME: 'Bob',   C_MKTSEGMENT: 'MACHINERY' },
]
```

The engine's storage and streaming interfaces use a columnar representation. Some operators, including hash joins, materialize rows internally; chapter 34 explains that boundary.

Consider `WHERE C_MKTSEGMENT = 'BUILDING'` over a million customers. With row objects, the engine follows references to records whose layout includes fields the predicate does not use. Reading one field does not evaluate all the others, but the memory access can bring unrelated bytes into a cache line. Columns place values of the same field together, so a scan can concentrate on that field. JavaScript objects also do not necessarily store a private hash map of properties: V8 supports several layouts, including shared shapes and directly stored properties; see [V8's explanation](https://v8.dev/blog/fast-properties).

That access pattern motivates the layout. Its performance depends on the operator and workload; chapter 31 measures where batching helps.

## Three rows, viewed two ways

Add Carol to the two rows above. The same logical table can be written as three arrays:

```text
row position:   0            1             2
C_CUSTKEY:     [1,           2,            3]
C_NAME:        ['Alice',     'Bob',        'Carol']
C_MKTSEGMENT:  ['BUILDING',  'MACHINERY',  'BUILDING']
```

This is a hand-written layout diagram, not the physical string encoding. Position 1 still denotes Bob across all three columns. To filter on segment, inspect the last array and remember positions `[0, 2]`. Reading the corresponding names gives Alice and Carol. A **chunk** packages these aligned columns and their row count so an operator can receive them together.

Keep that example in mind through the representation details below. On a first read, understand column alignment, chunks, and selection vectors; the exact typed arrays and string-encoding limits are implementation reference material.

## One column, one typed array

[`Column`](../../src/storage/column.ts) holds the values of a single column for a batch of rows. For fixed-width types it is a JavaScript typed array and nothing more:

```typescript
if (isFixedWidth(dataType)) {
  this._data = allocator.acquire(typedArrayCtorFor(dataType), capacity);
}
```

The type mapping is in [`data-type.ts`](../../src/storage/data-type.ts), and it is the whole type system of the engine:

| `DataType` | Backing array | Bytes |
|---|---|---:|
| `BOOLEAN` | `Uint8Array` | 1 |
| `INT32` | `Int32Array` | 4 |
| `INT64` | `BigInt64Array` | 8 |
| `FLOAT64` | `Float64Array` | 8 |
| `DECIMAL` | `BigInt64Array` | 8 |
| `DATE` | `Int32Array` | 4 |
| `TIMESTAMP` | `BigInt64Array` | 8 |
| `VARCHAR` | offsets plus a byte buffer | variable |

Eight types. `DATE` is an `Int32Array` of day numbers; `TIMESTAMP` and `DECIMAL` are `BigInt64Array`s with an agreed interpretation. No `Date` object is ever stored in a column or passed between operators — a date is an integer until the moment it is formatted for output. A few places construct one transiently to borrow the calendar arithmetic, such as parsing a string into a timestamp in [`castToType`](../../src/storage/data-type.ts), but the object never outlives the expression.

Nulls are not stored in the array. They live in a separate `nullBitmap`, one bit per row, packed into a `Uint32Array`. So a null `INT32` still occupies four bytes of the data array holding whatever was there, and the bitmap is the authority on whether to look. This is why `hasNulls` exists as a flag: an operator can skip null checking entirely for a column that has none, which is the common case.

## Strings are different

Strings do not fit in a typed array, so there are two representations.

A `Column` of type `VARCHAR` keeps a `Uint32Array` of offsets and one `Uint8Array` of packed UTF-8 bytes — the standard variable-length layout. But that is not what you usually get. [`DataChunk.fromSchema`](../../src/storage/chunk.ts) chooses differently:

```typescript
const columns: AnyColumn[] = schema.map(({ dataType }) => {
  if (dataType === DataType.VARCHAR) {
    return new DictionaryColumn(capacity);
  }
  return new Column(dataType, capacity);
});
```

[`DictionaryColumn`](../../src/storage/dictionary-column.ts) stores each distinct string once and keeps a `Uint16Array` of indices into that dictionary. Load 5,000 customers whose segment is one of two values and the column holds 5,000 two-byte integers plus two strings:

```
C_MKTSEGMENT dictionary entries: [ 'MACHINERY', 'BUILDING' ]
C_MKTSEGMENT indices array: Uint16Array
```

The win is not only memory. Comparing two dictionary-encoded values is an integer comparison, and a filter for `'BUILDING'` becomes a scan for one integer.

The ceiling is the `Uint16Array`: dictionary ids run from 0 to 65,535, and the value after that cannot be addressed. There is no fallback to a plain `Column` — [`set`](../../src/storage/dictionary-column.ts) throws instead:

```
Error: Dictionary capacity exceeded 65535 values per chunk
```

That is worth knowing before you meet it, because it is a hard failure rather than a slow path. A column of mostly-distinct strings is a case this encoding does not handle; chapter 41 covers the encodings that do.

`AnyColumn` is the union of the two, and operators that do not care which one they have use `get(i)` on either.

## The chunk

[`DataChunk`](../../src/storage/chunk.ts) is a set of columns plus a row count. That is nearly the whole class:

```typescript
export class DataChunk {
  columns: AnyColumn[];
  size: number;
  selectionVector: SelectionVector | null;
}
```

Chunks are how data moves. An operator does not receive a table or a row; it receives a chunk, does something to it, and passes a chunk on. `DEFAULT_CHUNK_SIZE` is 2,048, defined in [`config.ts`](../../src/config.ts), and you can watch the boundaries directly — 5,000 rows loaded into a relation become:

```
rows: 5000 | chunks: 3 | sizes: 2048, 2048, 904
```

### Why 2,048

The number is a compromise between two costs that pull in opposite directions.

Per-chunk overhead is fixed: a function call per operator, a bounds check, a loop setup, a null-bitmap check. Processing one row at a time pays that overhead once per row, which is the classic tuple-at-a-time interpreter and is dominated by bookkeeping. Making chunks larger spreads that cost over more rows, so bigger is better.

Working-set size pulls the other way. At 2,048 rows, one eight-byte column is 16 KB. A few such columns stay within the capacity of a typical CPU's L1 and L2 caches, so an operator reading a chunk, writing a chunk, and looping over both keeps its data close to the core. Make chunks large enough and each pass evicts the previous one, and you pay a cache miss per row instead of an interpreter dispatch per row — having traded one overhead for a worse one.

Somewhere in the low thousands both costs are small. Engines built this way — a batch of column values at a time, rather than a row at a time — are called **vectorized**, and every vectorized engine lands in that neighborhood. The specific value is a tuning decision, not a law, and `DEFAULT_CHUNK_SIZE` is one line to change if you want to measure it yourself. Chapter 31 does exactly that.

## Selection vectors

Now the piece that makes filtering cheap.

A filter removes rows. The obvious implementation allocates a new chunk and copies the survivors into it. For a selective filter that is mostly wasted work, and for a non-selective one it copies nearly everything for no reason.

Instead, a chunk can carry a **selection vector**: an array of the row indices that are still live. Filtering writes indices, not values.

```typescript
getValue(rowIndex: number, colIndex: number): ColumnValue {
  const actualRow = this.selectionVector ? this.selectionVector[rowIndex] : rowIndex;
  return this.columns[colIndex].get(actualRow);
}
```

Every read goes through one level of indirection, and `size` becomes the count of selected rows rather than the count of stored rows. Set a selection vector of `[0, 2, 4]` on a chunk and it behaves like a three-row chunk whose values are rows 0, 2, and 4:

```
after selection vector, size: 3 | values: 0, 2, 4
```

The columns were not touched. Nothing was copied. A chain of filters narrows the vector further, and the underlying arrays stay exactly where they were.

Eventually something has to materialize — a hash join needs real rows to put in its hash table, and an operator that produces a differently shaped result cannot express it as a subset of its input. [`flatten`](../../src/storage/chunk.ts) does that: it builds new columns containing only the selected rows and returns a chunk with no selection vector. You will see `chunk.selectionVector ? chunk.flatten() : chunk` at the top of operators that need dense data, and it is exactly the boundary where the engine stops being lazy.

Two related methods matter for the same reason. [`project`](../../src/storage/chunk.ts) builds a chunk from a subset of the existing columns **by reference** — dropping columns costs nothing. And [`scanView`](../../src/storage/chunk.ts) produces a read-only view over the same data, which is what a table scan yields so that reading a page does not copy it.

## In the code

| Thing | Where |
|---|---|
| Column of fixed-width values | [`Column`](../../src/storage/column.ts) |
| Dictionary-encoded strings | [`DictionaryColumn`](../../src/storage/dictionary-column.ts) |
| Type enum and array mapping | [`DataType`](../../src/storage/data-type.ts) |
| Batch of columns | [`DataChunk`](../../src/storage/chunk.ts) |
| Materializing a selection | [`flatten`](../../src/storage/chunk.ts) |
| Null bit manipulation | [`src/utils/bitmap.ts`](../../src/utils/bitmap.ts) |
| Chunk size | [`DEFAULT_CHUNK_SIZE`](../../src/config.ts) |
| Rows to chunks | [`InMemoryRelation`](../../src/dataframe/in-memory-relation.ts) |

## Traps

**`size` is not the number of stored values.** With a selection vector, `size` is how many rows are selected while the columns still hold the original count. Indexing a column directly with a loop counter instead of going through `getValue` or `activeRowIndex` reads the wrong rows — and reads plausible-looking data rather than crashing, which is worse.

**`flatten()` discards the dictionary encoding.** It constructs plain `Column` instances, so a `DictionaryColumn` comes back as a `VARCHAR` column with offsets and bytes. Correct, but it means materializing a filtered chunk of strings costs more than the row count alone suggests.

**A null value still occupies its slot.** The data array is full-width regardless; only the bitmap says whether a slot is meaningful. Reading the array without consulting the bitmap yields whatever was left there.

**`project` shares columns.** The new chunk points at the same underlying arrays. Mutating a column reached through a projected chunk mutates the original, which is why operators build new columns for output rather than writing into their input.

## Recap

- Data is stored **column by column**, so an operator touches only the columns it needs.
- A **`Column`** is a typed array plus a **null bitmap**; nulls occupy their slot in the data array and are recorded out of band.
- Strings are usually **dictionary-encoded** — a `Uint16Array` of indices into a table of distinct values — which turns string comparison into integer comparison. The 16-bit index is a hard ceiling: past id 65,535 the column throws rather than falling back.
- A **`DataChunk`** is a set of columns plus a size, and it is the unit that moves between operators. The default is **2,048 rows**, used to amortize per-chunk overhead. Cache fit also depends on row width, live columns, and hardware.
- A **selection vector** lets a filter narrow a chunk without copying anything; `flatten` is where the engine finally materializes.

That completes Part 0. Next: Part 1 starts at the beginning of the pipeline, [turning SQL text into tokens](../01-frontend/05-the-lexer.md).
