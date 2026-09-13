# 33. Filters and expression evaluation

> After this chapter you will be able to trace a filter's selection vector and evaluate its null cases without confusing logical positions with stored row indices.

## The question

Three rows in a table, one of them null:

```
WHERE X < 3                  -> 1
WHERE NOT (X < 3)            -> 1
WHERE X IS NULL              -> 1
```

One row matches the predicate, one matches its negation, and one is null. Three rows, three answers, and they add up. Now:

```
WHERE X = X                  -> 2
WHERE X IN (1, NULL)         -> 1
WHERE X NOT IN (1, NULL)     -> 0
```

`X = X` loses a row. `NOT IN` loses all of them — including the row where `X` is 3, which is plainly not 1 and plainly not equal to the null. Every SQL engine does this, and it is usually taught as a rule to memorize. In this engine it is two lines of [`compileExpression`](../../src/execution/expression-eval.ts), and once you have read them you will never have to memorize it again.

## A filter does not remove rows

Start with what the operator does to a chunk, because it is not what "filter" suggests. Here are ten rows, and a predicate keeping four of them, then a second predicate keeping three:

```
A values     : 0 1 2 0 1 2 0 1 2 0
B values     : 0 1 2 3 4 5 6 7 8 9
after A = 0  : size 4 | sv 0, 3, 6, 9
then B > 2   : size 3 | sv 3, 6, 9
columns still the originals? true
flatten()    : size 3 | sv null | B = 3, 6, 9
```

Nothing was copied. Both output chunks point at the *same* `Column` objects as the input; what changed is the **selection vector** introduced in [chapter 4](../00-orientation/04-rows-columns-and-chunks.md) — an array of the row indices still live — and the `size`. A chain of filters narrows the vector and leaves the data alone. Materialization happens later, and only where an operator genuinely needs dense rows.

[`_executeFallback`](../../src/execution/operators/filter.ts) is the loop that produces it:

```typescript
_executeFallback(chunk: DataChunk): DataChunk {
  const size = chunk.size;
  const sv = new Uint32Array(size);
  let count = 0;

  if (chunk.selectionVector) {
    const inputSv = chunk.selectionVector;
    for (let i = 0; i < size; i++) {
      const rowIdx = inputSv[i];
      if (this.evaluator(chunk, rowIdx)) {
        sv[count++] = rowIdx;
      }
    }
  } else {
    for (let i = 0; i < size; i++) {
      if (this.evaluator(chunk, i)) {
        sv[count++] = i;
      }
    }
  }

  if (count === 0) return new DataChunk(chunk.columns, 0);
  if (count === size) return chunk;
  ...
}
```

Two loops, differing only in whether the row index comes from an existing selection vector. Note that the written indices are always **physical** row numbers, never positions within the incoming selection — which is why filters compose without an extra indirection per level.

Two special cases avoid work at the ends. If nothing survives, a size-zero chunk is returned and the sink chain drops it. If everything survives, **the input chunk is returned unchanged** — the same object, with no selection vector allocated. A non-selective filter over a chunk costs one predicate evaluation per row and nothing else.

The last detail is an allocation choice:

```typescript
if (count > 64) {
  result.setSelectionVector(sv.subarray(0, count), count);
} else {
  result.setSelectionVector(sv.slice(0, count), count);
}
```

`subarray` is a view over the full-size buffer, so it costs nothing but keeps all `size` words alive. `slice` copies. Below 64 surviving rows the copy is cheaper than retaining the buffer; above it, the view wins.

## The predicate is a tree of closures

`this.evaluator` is a `CompiledExpr`, and the type says everything about the evaluation model:

```typescript
export type CompiledExpr = (chunk: DataChunk, rowIdx: number) => EvalValue;
```

One row at a time. [`compileExpression`](../../src/execution/expression-eval.ts) walks a bound expression once, at pipeline-build time, and returns a closure that walks no trees at run time:

```typescript
case BoundExprKind.BINARY: {
  const left = compileExpression(expr.left, columnMapping);
  const right = compileExpression(expr.right, columnMapping);
  const timestampOperand = getExprType(expr.left) === DataType.TIMESTAMP
    || getExprType(expr.right as BoundExpr) === DataType.TIMESTAMP;
  return compileBinaryOp(expr.op, left, right, timestampOperand);
}
```

Everything that can be decided once is decided once: which column index a reference resolves to, which operator function to call, whether an operand is a timestamp. What remains at run time is a call through a closure per node per row. That is what chapter 31 measured as the "scalar" path, and it is about five times slower than a typed-array loop — but it handles every expression form the language has, and the typed-array loop handles four arithmetic operators.

Some cases earn their own compile-time work. `IN` over a list of literals builds a `Set` and closes over it, so the run-time cost is one hash lookup rather than a loop over the list. `LIKE` translates its pattern to a `RegExp` and keeps a bounded cache of up to `LIKE_CACHE_MAX` compiled patterns, which matters when the pattern is itself a column rather than a literal.

### Resolving a column

[`resolveColumnIndex`](../../src/execution/column-resolve.ts) turns a bound column reference into an index into the chunk's columns, and it tries two keys:

```typescript
export function lookupColumnIndex(expr: BoundColumnRefNode, columnMapping: ColumnMapping | null): number | null {
  if (!columnMapping) return expr.columnIndex >= 0 ? expr.columnIndex : null;
  const qualified = `${expr.tableAlias}.${expr.columnName}`.toUpperCase();
  const qualifiedIndex = columnMapping.get(qualified);
  if (qualifiedIndex !== undefined) return qualifiedIndex;
  const unqualifiedIndex = columnMapping.get(expr.columnName.toUpperCase());
  return unqualifiedIndex === undefined ? null : unqualifiedIndex;
}
```

Qualified first, then bare. The mapping is built per operator by `buildSchemaMapping`, and a join's mapping is the concatenation of its two inputs' mappings with the right-hand indices offset. When a lookup fails, [`UnresolvedReferenceError`](../../src/execution/column-resolve.ts) is raised with the full list of keys that *were* available — which turns the most common execution-layer bug from a silent `undefined` into a message naming the mismatch.

There is a third resolution path that is easy to miss. Before dispatching on kind, `compileExpression` checks whether the whole expression already exists as a column:

```typescript
const materialized = materializedColumnOf(expr, columnMapping);
if (materialized !== null) {
  return (chunk: DataChunk, rowIdx: number) => chunk.columns[materialized]?.get(rowIdx) ?? null;
}
```

[`materializedColumnOf`](../../src/execution/expression-eval.ts) looks up the expression's [`exprKey`](../../src/binder/expr-key.ts) — a canonical string form — in the column mapping, for the kinds that an operator below might have computed already: binary, unary, function, aggregate, case, cast, extract, and window. This is how `HAVING SUM(x) > 5` finds the sum computed by the aggregate below it instead of trying to evaluate an aggregate row by row. Without it, `compileExpression` reaches the `AGGREGATE` case and throws.

## Three-valued logic

Now the opening question. SQL has three truth values, and this engine represents the third as JavaScript `null` flowing through the same closures as `true` and `false`.

The comparison operators live in [`binaryValueOp`](../../src/execution/value-ops.ts) and return `null` when either operand is null. So `X = X` on a null row yields `null`, and `_executeFallback` keeps a row only `if (this.evaluator(chunk, rowIdx))` — a truthiness test, under which `null` is not kept. **A filter keeps rows where the predicate is `true`, and discards both `false` and unknown.** That is the whole of `WHERE`'s null behavior, and it is one `if`.

`NOT` propagates unknown rather than flipping it, so `NOT (X < 3)` also discards the null row. Both the predicate and its negation discard it, which is why the first three counts add to three and not to more.

`IN` is where it becomes interesting, because the compiled form has to track whether the list contained a null:

```typescript
const litHasNull = list.some((i) => (i as BoundLiteralNode).value === null || ... === undefined);
const values = new Set(list.filter((i) => (i as BoundLiteralNode).value != null).map(...));
const has = (v: EvalValue) => values.has(normalizeComparable(v)) ? true : (litHasNull ? null : false);
```

Read `has`. A hit is `true`. A miss is `false` **only if the list had no nulls**; if it did, a miss is `null`, because the value might have equalled the null and there is no way to know. And then:

```typescript
return negated ? (res === null ? null : !res) : res;
```

`NOT IN` negates that. For `X = 3` against `(1, NULL)`: not in the set, list has a null, so `IN` is unknown, so `NOT IN` is unknown, so the row is discarded. For `X = 1`: in the set, `IN` is true, `NOT IN` is false, discarded. And the null row is discarded because its value is null before the list is even consulted. Three rows, three discards, zero results — derived, not memorized.

`BETWEEN` does the same bookkeeping by hand, computing `ge` and `le` separately and combining them so that one definite `false` beats an unknown:

```typescript
if (ge === false || le === false) res = false;
else if (ge === null || le === null) res = null;
else res = true;
```

## The path that does not run

`FilterOperator.process` begins with a branch this book has to be honest about:

```typescript
async process(chunk: DataChunk): Promise<DataChunk> {
  const size = chunk.size;
  if (size === 0) return new DataChunk(chunk.columns, 0);

  if (this.parallelDispatch) {
    const plan = this._analyze(this.predicate);
    if (plan) {
      const result = await this._executeParallel(chunk, plan);
      if (result) return result;
    }
  }

  return this._executeFallback(chunk);
}
```

More than half of [`filter.ts`](../../src/execution/operators/filter.ts) implements that branch: [`_analyze`](../../src/execution/operators/filter.ts) recognizes column-versus-literal comparisons, `BETWEEN`, and `AND`/`OR` trees over them, and [`_executeParallel`](../../src/execution/operators/filter.ts) dispatches each leaf to a worker kernel and merges the resulting selection vectors with [`intersectSorted`](../../src/execution/operators/filter.ts) and [`unionSorted`](../../src/execution/operators/filter.ts).

`parallelDispatch` is set only by `setParallelContext`, which is called only from `enableParallel`, which is called only by the CLI. **In the library — `createEngine()` and everything the test suite does — it is `null`, and every filter takes the fallback path.** The kernel path is real code with real tests; it is not code that runs when you call `engine.run`.

## In the code

| Idea | Where |
|---|---|
| Filter operator | [`FilterOperator`](../../src/execution/operators/filter.ts) |
| The loop that always runs | [`_executeFallback`](../../src/execution/operators/filter.ts) |
| Kernel path, CLI only | [`_executeParallel`](../../src/execution/operators/filter.ts) |
| Selection-vector merging | [`intersectSorted`](../../src/execution/operators/filter.ts) |
| Expression compiler | [`compileExpression`](../../src/execution/expression-eval.ts) |
| Reusing a column computed below | [`materializedColumnOf`](../../src/execution/expression-eval.ts) |
| Scalar operator semantics | [`binaryValueOp`](../../src/execution/value-ops.ts) |
| `LIKE` to `RegExp` | [`likeToRegex`](../../src/execution/expression-eval.ts) |
| Casts | [`castToType`](../../src/storage/data-type.ts) |
| Column reference to index | [`resolveColumnIndex`](../../src/execution/column-resolve.ts) |
| Diagnostic on failure | [`UnresolvedReferenceError`](../../src/execution/column-resolve.ts) |
| Where the filter sink is built | [`buildFilter`](../../src/execution/builders/pipeline-builders.ts) |

## Traps

**`size` is not the number of stored rows.** After a filter, the columns still hold every original value and only `size` and the selection vector changed. An operator that loops `for (let i = 0; i < chunk.size; i++)` and indexes a column with `i` reads the wrong rows and returns plausible garbage. Use `chunk.activeRowIndex(i)` or `chunk.getValue(i, c)`.

**A filter that keeps everything returns its input by identity.** Code that assumes the output chunk is a fresh object — and mutates it — will mutate the input. This is why `buildFilter` passes the result along rather than writing into it.

**`compileExpression` returns `() => null` for anything it does not recognize.** An unsupported function name falls to the `default` case of [`compileFunction`](../../src/execution/expression-eval.ts) and evaluates to null on every row, which a `WHERE` then discards. The query returns zero rows rather than an error. The thirteen names that switch handles are the entire scalar function library of the execution layer.

**Comparisons coerce.** [`normalizeComparable`](../../src/execution/value-ops.ts) is applied to `IN` list members and their probes, and the scalar operators compare after converting `bigint` to `number`. That makes `INT64` and `DECIMAL` comparisons lossy above 2^53 — a real limit of storing them as `BigInt64Array` but comparing them as doubles.

**A `Filter` above a `Scan` may run twice as a predicate.** The same expression is also compiled into a zone-map pruner, as [chapter 32](32-scans-and-zone-maps.md) covers. The two compilations are independent and share no code.

## Recap

- A filter writes a **selection vector** of surviving physical row indices and shares its input's columns. Nothing is copied, and a chain of filters narrows one vector.
- The two shortcuts matter: **nothing survives** returns a size-zero chunk, and **everything survives** returns the input chunk itself.
- A predicate is compiled once into a **tree of closures** with column indices, operator functions, `Set`s, and regular expressions already resolved. Evaluation is one row at a time.
- Before compiling, the expression is looked up by [`exprKey`](../../src/binder/expr-key.ts) in the column mapping, so an expression an operator below already computed is read as a column instead of recomputed.
- `NULL` flows through the same closures as a JavaScript `null`, and `WHERE` keeps only rows where the predicate is **truthy** — so unknown is discarded exactly like false. `IN` tracks whether its list contained a null so that a miss can be unknown rather than false, and `NOT IN` inherits that.
- The kernel-accelerated filter path in `filter.ts` requires `parallelDispatch`, which only the CLI sets up. In library use every filter runs `_executeFallback`.

Next: [chapter 34](34-hash-join.md) takes the rows that survive and puts them in a hash table — or, when the table will not fit, on disk.
