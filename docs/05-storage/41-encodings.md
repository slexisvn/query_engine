# 41. Encodings

> After this chapter you will be able to compare three integer encoding strategies and explain why an encoder accepts or declines a column.

## The question

Two `INT32` columns, 2,048 values each, written into the same page. `SEGMENT` holds `Math.floor(i / 512)` — four distinct values in four solid blocks. `ID` holds `i` — nothing but 0, 1, 2, 3, up to 2,047.

Ask the engine what it stored:

```
--- sorted blocks of 512  (INT32, 2048 values, min=0 max=3 runs=4) ---
  flat payload bytes: 8192
  chooseEncoder -> RUN_LENGTH
  encoded byteSize: 36  ratio 0.004

--- sequential ids 0..2047  (INT32, 2048 values, min=0 max=2047 runs=2048) ---
  flat payload bytes: 8192
  chooseEncoder -> BIT_PACKED
  encoded byteSize: 2821  ratio 0.344
```

Thirty-six bytes against 2,821. The column a human would call the most compressible thing in the table — a regular arithmetic sequence, reconstructible from two numbers — comes out seventy-eight times larger than the blocky one. Everything here follows from *what the three encoders actually look at*.

## Compare the representations first

For `[1000, 1000, 1000, 1001]`, run-length encoding records `(1000,3)` and `(1001,1)`. Frame of reference records base 1000 and offsets `[0,0,0,1]`. Bit packing the original non-negative values needs ten bits per value, because 1001 needs ten binary digits. These are hand-computed payloads: real encodings also store headers, null information, and alignment. Those fixed costs can outweigh a payload saving on a tiny column.

## Three encoders, one shape

[`src/storage/encoding/registry.ts`](../../src/storage/encoding/registry.ts) is the entire list:

```typescript
const REGISTERED_ENCODERS: ReadonlyArray<ColumnEncoder> = [
  runLengthEncoder,
  bitPackedEncoder,
  frameOfReferenceEncoder,
];
```

Each implements [`ColumnEncoder`](../../src/storage/encoding/encoding-types.ts) — a `kind`, an `id`, and three methods:

```typescript
plan(stats: IntegerColumnStats, dataType: DataType): EncodingPlan | null;
encode(source: EncodableVector): EncodedVector;
read(reader: ByteReader, dataType: DataType, length: number): EncodedVector;
```

`plan` is the interesting one. It answers "how many bytes would I take, and is this a shape I am good at?" **without touching the data** — it is given only a `length`, a `runCount`, a `min`, and a `max`, all four produced by [`summarizeIntegers`](../../src/storage/encoding/integer-values.ts) in a single pass. Selection costs exactly one scan of the column no matter how many encoders are registered. The `id` is written into the serialized page so [`encoderForId`](../../src/storage/encoding/registry.ts) can pick the decoder back up; adding a fourth encoder means appending to `REGISTERED_ENCODERS` and choosing an unused id, and nothing else changes.

**Run-length** ([`runLengthEncoder`](../../src/storage/encoding/run-length.ts)) stores one start offset and one value per run of equal values, answering `valueAt` with a binary search over the starts. It exploits *repetition*.

**Bit packing** ([`bitPackedEncoder`](../../src/storage/encoding/bit-packed.ts)) computes how many bits the largest value needs and packs every value into that many bits inside a `Uint32Array`. It exploits *small magnitude*.

**Frame of reference** ([`frameOfReferenceEncoder`](../../src/storage/encoding/frame-of-reference.ts)) subtracts the minimum and stores the differences in the narrowest of a `Uint8Array`, `Uint16Array`, or `Uint32Array` that holds the range. It exploits *narrow range*, wherever on the number line that range sits.

A run of consecutive integers has no repetition, magnitude that grows with the row count, and a range equal to the row count — the one shape none of the three is designed for. There is no delta encoding here, and the opening result is that absence, measured.

## What it costs, on real data

Six columns, 6,144 rows, three pages, written through `Table`. Bytes are `columnRetainedBytes` summed over the three stored chunks:

| Column | Shape | FLAT | RUN_LENGTH | BIT_PACKED | FRAME_OF_REF | AUTO |
|---|---|---:|---:|---:|---:|---:|
| `ID` | `i` | 25,344 | 49,932 | 9,999 | 13,083 | **9,999** |
| `SEGMENT` | `i / 512` | 25,344 | **876** | 3,087 | 6,939 | **876** |
| `BUCKET` | `i % 16` | 25,344 | 49,932 | **3,855** | 6,939 | **3,855** |
| `OFFSETV` | `-1000 + i % 251` | 25,344 | 49,932 | 25,344 | **6,939** | **6,939** |
| `STAMP` (`INT64`) | `1700000000000 + i` | 49,920 | 74,508 | 49,920 | **13,083** | **13,083** |
| `OPT` | `i % 100`, null every 7th | 25,344 | 49,788 | **6,159** | 6,939 | **6,159** |
| **Total** | | **176,640** | 274,968 | 98,364 | 53,922 | **40,911** |

Automatic selection lands at **40,911 bytes against 176,640 — a ratio of 0.232** — and beats every single-encoding column store, because it picks per column and per chunk. Two cells repeat the flat number exactly: `OFFSETV` and `STAMP` under forced `BIT_PACKED`. That is the encoder *declining*, which is the next section.

## When an encoder declines

[`chooseEncoder`](../../src/storage/encoding/column-encoding.ts) is the whole policy:

```typescript
if (stats.length < Config.encodingMinRows) return null;

let best: EncodingChoice | null = null;
for (const encoder of COLUMN_ENCODERS.values()) {
  const plan = encoder.plan(stats, dataType);
  if (plan === null || !plan.withinThreshold) continue;
  if (best === null || plan.bytes < best.bytes) best = { encoder, bytes: plan.bytes };
}

if (best === null) return null;
return best.bytes <= flatBytes(stats, dataType) * Config.encodingMinCompressionRatio ? best.encoder : null;
```

There are four separate ways a column ends up flat.

**It is not an integer column.** [`ENCODABLE_TYPES`](../../src/storage/encoding/integer-values.ts) is exactly `{INT32, INT64}`. A `DATE` column is an `Int32Array` of day numbers — ideal frame-of-reference material — and is never offered to an encoder. Neither is a `FLOAT64` column of one repeated value:

```
DATE column encodeColumnValues: null
FLOAT64 all-identical encodeColumnValues: null
```

**It is too short.** Below `encodingMinRows`, 64 by default, selection stops before planning. Forty sequential values would bit-pack to 37 bytes from 160 and are stored flat anyway: the fixed cost of an encoded column is not worth paying on a chunk that small.

**No encoder can represent it, or none is within its threshold.** Each `plan` returns `null` for shapes it cannot express, and sets `withinThreshold` for shapes it is willing to be used on:

| Encoder | Returns `null` when | `withinThreshold` |
|---|---|---|
| `RUN_LENGTH` | never | `runCount <= length * encodingRleMaxRunRatio` (0.5) |
| `BIT_PACKED` | `min < 0`, or the maximum needs more than 32 bits | `bitWidth <= nativeBits * encodingBitPackMaxWidthRatio` (0.75) |
| `FRAME_OF_REFERENCE` | range ≥ 2³² | `offsetWidth <= byteWidth * encodingForMaxWidthRatio` (0.5) |

That table explains both flat cells above. `OFFSETV` starts at −1000 and bit packing has no sign bit; `STAMP` holds values near 1.7 × 10¹², which need 41 bits. Both plans are `null`, and under a forced mode there is no second choice.

The `withinThreshold` flags stop an encoding from being chosen only because it happens to be a few bytes smaller. Frame of reference on an `INT32` may use a 1- or 2-byte offset (4 × 0.5 = 2) but never a 4-byte one, because that column is the size of the original plus a header and the arithmetic on every read would buy nothing.

**It compresses, but not enough.** The final gate is `encodingMinCompressionRatio`, 0.75: a column has to get at least a quarter smaller to be worth decoding on every read. A column of large, unsorted positive integers fails every check at once:

```
--- sparse positive random  (INT32, 2048 values, min=1144129 max=2147361978 runs=2048) ---
  BIT_PACKED           plan bytes:    7941  ratio 0.969  withinThreshold: false
  FRAME_OF_REFERENCE   plan bytes:    8201  ratio 1.001  withinThreshold: false
  chooseEncoder -> null (stays flat)
```

Note the second line: 8,201 bytes for 8,192 bytes of input. **An encoder may plan a size larger than flat.** The thresholds and the ratio gate are what keep such a plan from being used.

## Choosing per chunk, not per column

Nothing above is decided for a column of a table. It is decided for the 2,048 values in one chunk, by `encodeChunkColumns` at the moment [`addChunk`](../../src/storage/table.ts) seals a page — so one logical column can land on different encodings in different pages, and on different bit widths within one encoding. `packedBitWidth` derives the width from `stats.max`, so the third page of a growing table pays more per value than the first. Frame of reference stores an anchor instead, so a timestamp column that climbs forever costs the same on every page while a sequential key does not:

```
page 0: ID 3077 (BIT_PACKED, 11 bits)  STAMP 4361 (FRAME_OF_REFERENCE)
page 1: ID 3333 (BIT_PACKED, 12 bits)  STAMP 4361 (FRAME_OF_REFERENCE)
page 2: ID 3589 (BIT_PACKED, 13 bits)  STAMP 4361 (FRAME_OF_REFERENCE)
```

## Reading an encoded column back

[`Column.fromEncoded`](../../src/storage/column.ts) produces a `Column` with `_data` unset and an `encoded` vector in its place, and `get` routes around the missing array by calling `this.encoded.valueAt(index)` — a shift and a mask for bit packing, an addition for frame of reference, a binary search for run length. The null bitmap is checked *before* that, exactly as for a flat column, so nulls cost nothing extra and the encoding never has to represent them.

The other half of `EncodedVector` is `decode()`, which materializes the whole typed array. Reaching for it is not explicit — it is the `data` getter:

```typescript
get data(): AnyTypedArray | undefined {
  if (this.encoded !== null) {
    this._data = this.encoded.decode();
    this.encoded = null;
  }
  return this._data;
}
```

**Reading `.data` on an encoded column permanently unencodes it.** Measured on a 2,048-row column of values 0–15:

```
form before: ENCODED retained: 1285
get(5) via encoded valueAt: 5
after touching .data -> form: FLAT retained: 8448
```

One property access, and the page grew by a factor of 6.6. An operator that wants raw arrays — a vectorized kernel, a radix sort — pays that once per column per page; operators that go through `get` never trigger it.

## Dictionaries are a different mechanism

A `VARCHAR` column arrives as a [`DictionaryColumn`](../../src/storage/dictionary-column.ts) from `DataChunk.fromSchema`, before any of this runs, and `encodeColumnValues` skips it — it is not a `Column`, and `VARCHAR` is not in `ENCODABLE_TYPES`. So `DICTIONARY` is the one storage form no cost comparison ever chose. Build 2,048 distinct strings both ways and ask what each costs as a page record:

```
flat VARCHAR serialized record: 33721   dictionary record: 37813
```

The dictionary is a *loss* of 4,092 bytes on a column with no repetition — every string is stored once and then addressed by a two-byte index that is pure overhead. Unlike the integer encodings, nothing checks: there is no `plan`, no threshold, no fallback. Chapter 4 covered the 65,535-value ceiling this design imposes; this is its other edge.

## Forcing an encoding, and proving it is safe

Two environment variables in [`src/config.ts`](../../src/config.ts) override selection. `QE_COLUMN_ENCODING=0` turns the whole pipeline off. `QE_FORCED_COLUMN_ENCODING=RUN_LENGTH` takes a short path at the top of `chooseEncoder` that looks the named encoder up, calls its `plan`, and returns it unless that plan is `null`. `encodingMinRows`, `withinThreshold`, and `encodingMinCompressionRatio` are all skipped — which is why forced `RUN_LENGTH` stores `ID` in 49,932 bytes against a flat 25,344. The mode is a diagnostic, not a tuning knob.

Those variables exist because they make a differential test possible. [`tests/e2e/column-encoding-differential.test.ts`](../../tests/e2e/column-encoding-differential.test.ts) builds a fact table over the six columns above — plus an all-null `INTEGER`, a `VARCHAR`, and a `DOUBLE`, so the null path and the two forms no encoder ever touches are covered as well — five times: unencoded, once per forced encoding, and automatic. It runs a 56-query corpus against each and asserts every result equals the unencoded baseline row for row. It also checks that the encoded builds really did store what they claim, so a silently disabled encoder cannot pass by producing flat pages. A second block repeats five queries with the WASM kernels on; a third asserts the size properties directly. [`tests/helpers/encoding-fixtures.ts`](../../tests/helpers/encoding-fixtures.ts) supplies the round-trip helpers the unit tests use on each vector in isolation.

## In the code

| Idea | Where |
|---|---|
| The encoder list | [`src/storage/encoding/registry.ts`](../../src/storage/encoding/registry.ts) |
| The encoder contract | [`ColumnEncoder`](../../src/storage/encoding/encoding-types.ts) |
| One pass for length, runs, min, max | [`summarizeIntegers`](../../src/storage/encoding/integer-values.ts) |
| Which types are eligible | [`ENCODABLE_TYPES`](../../src/storage/encoding/integer-values.ts) |
| The policy | [`chooseEncoder`](../../src/storage/encoding/column-encoding.ts) |
| Applying it to a whole chunk | [`encodeChunkColumns`](../../src/storage/encoding/column-encoding.ts) |
| Runs of equal values | [`RunLengthVector`](../../src/storage/encoding/run-length.ts) |
| Values packed into *n* bits | [`BitPackedVector`](../../src/storage/encoding/bit-packed.ts) |
| Offsets from a shared anchor | [`FrameOfReferenceVector`](../../src/storage/encoding/frame-of-reference.ts) |
| Wrapping a vector as a column | [`Column.fromEncoded`](../../src/storage/column.ts) |
| Every threshold above | [`Config`](../../src/config.ts) |

## Traps

**Nulls influence the choice.** A null still occupies its slot in the data array — zero, in a freshly allocated one — and `summarizeIntegers` reads the raw array. Nulling every seventh entry of a column of values near 1,000,000 drags `min` to 0:

```
nulls every -: min=1000000 max=1001999 runs=2048 -> FRAME_OF_REFERENCE 4105 bytes
nulls every 7: min=0       max=1001999 runs=2048 -> BIT_PACKED       5125 bytes
```

The answer stays correct, because `get` consults the bitmap first, but the page is 25% larger on account of values nothing will ever read.

**Bit packing looks at the maximum, not the range.** `packedBitWidth` is `bitLength(stats.max)`, so values between 4,096 and 6,143 need 13 bits despite a range of 2,047. Frame of reference is the encoder that cares about range.

**`RUN_LENGTH` never returns `null`.** Under `QE_FORCED_COLUMN_ENCODING=RUN_LENGTH` every eligible column is encoded, including ones that double in size.

**Encoded payloads are always heap-allocated.** `encode` uses plain `new Uint32Array(...)` rather than the column's allocator, so an encoded column is on the heap even when `QE_SAB_COLUMNS` is on. Deserialization goes through the allocator; construction does not.

## Exercises

### Understand

How would run-length encoding and frame of reference represent [1000,1000,1000,1001]?

### Practice

1. **Observe.** Reproduce the two opening measurements. Build a 2,048-value `Column` for each shape, call `summarizeIntegers` on `column.data`, and print each encoder's `plan` alongside `chooseEncoder`'s answer.

2. **Observe.** Find the smallest change to the sequential-id column that makes run-length win, then the smallest that makes it stay flat.

3. **Observe.** Set `QE_ENCODING_MIN_COMPRESSION_RATIO=1.0` and re-measure the six-column table. Which columns become encoded, and what does the total become? Now set it to `0.1`.

4. **Extend (optional).** Add a fourth encoder — delta, storing the first value and the differences between neighbors — with an unused id, declining when a difference does not fit in a byte. Confirm the sequential-id column drops below 3,000 bytes and the differential test still passes.

5. **Extend (optional).** Instrument the `data` getter to log a stack trace when it decodes, then run the book's query with `QE_WASM_MIN_CHUNK=1`. Which operators force columns back to flat, and what does it cost across the scan?

### Hints and expected observations

Run length stores runs (1000,3) and (1001,1). Frame of reference stores base 1000 and offsets [0,0,0,1]. Compare headers as well as payload size before choosing.

## Recap

- Three encoders are registered: **run length** for repetition, **bit packing** for small magnitude, **frame of reference** for narrow range. There is no delta encoding, which is why a sequential column compresses badly.
- Selection is **per chunk** and costs **one pass**: `summarizeIntegers` produces a length, run count, min, and max, and every `plan` decides from those four numbers alone.
- A column stays flat if its type is not `INT32` or `INT64`, if it is shorter than **`encodingMinRows`**, if no encoder is representable and **within its threshold**, or if the winner is not at least a quarter smaller than flat.
- Automatic selection retained **40,911 bytes against 176,640** on the six-column measurement, beating every forced single encoding.
- Reading `.data` on an encoded column **decodes it permanently**; `get` and `valueAt` do not.
- `QE_COLUMN_ENCODING` and `QE_FORCED_COLUMN_ENCODING` exist so a differential test can run one query corpus five ways and assert identical answers.

Next: [chapter 42](42-pages-caching-and-btree.md) follows an encoded page out of `addChunk` — into a page store, through an LRU cache that the scan path pointedly does not use, and into the B-tree that indexes it.
