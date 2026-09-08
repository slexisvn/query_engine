# 9. Types, coercion, and expressions

> After this chapter you will be able to predict the type of any expression this engine accepts, explain why `5 / 2` is `2.5` here and `2` in PostgreSQL, and name the two helper functions the entire optimizer is built on.

## The question

```sql
SELECT 5 / 2
```

PostgreSQL answers `2`. This engine answers `2.5`:

```
SELECT 5 / 2 -> [{"R":2.5}]
```

Neither is wrong. Integer division is a choice, and it is made in one line of a 45-line file. This chapter is about that file and the decisions in it, because every one of them is visible in query results and none of them is arbitrary.

## The whole type system

Chapter 4 introduced the eight storage types. Expression typing works over the same eight — there is no separate expression type lattice, no numeric tower, no implicit `NUMERIC(p,s)` promotion. [`src/binder/type-inference.ts`](../../src/binder/type-inference.ts) is 45 lines and contains four functions:

```typescript
export function inferComparisonType(): DataType {
  return DataType.BOOLEAN;
}

export function inferLogicalType(): DataType {
  return DataType.BOOLEAN;
}
```

Two of them are constants. A comparison yields `BOOLEAN`; so does `AND`. They exist as functions rather than literals so that the call sites read uniformly, and so that adding three-valued-logic subtleties later would have one place to go.

## `BOOLEAN` has three values

That last phrase deserves unpacking now rather than later, because half the difficulty in Part 3 comes from it.

SQL's booleans have three values, not two: `TRUE`, `FALSE`, and `NULL`, meaning *unknown*. Any comparison with a `NULL` operand yields `NULL` rather than a verdict — `NULL = 1` is unknown, and so is `NULL = NULL`. The connectives propagate that, except where one operand settles the question by itself:

| | result |
|---|---|
| `FALSE AND NULL` | `FALSE` — one false operand is enough |
| `TRUE AND NULL` | `NULL` |
| `TRUE OR NULL` | `TRUE` — one true operand is enough |
| `FALSE OR NULL` | `NULL` |
| `NOT NULL` | `NULL` |

And the rule that makes all of it visible: **`WHERE` keeps a row only when the predicate is `TRUE`**, so unknown is discarded exactly like false. That is why `WHERE x = x` drops the rows where `x` is null, and it is the seed of every null-related surprise in this book — the `LEFT JOIN` demotion in [chapter 17](../03-optimizer/17-predicate-pushdown.md), the `NOT IN` result in [chapter 26](../03-optimizer/26-subquery-unnesting.md), the four-valued interpreter in [chapter 18](../03-optimizer/18-inference-and-outer-to-inner.md). [Chapter 33](../04-execution/33-filters-and-expression-evaluation.md) shows the two lines of the evaluator that implement it.

Note what the type system does *not* record: `BOOLEAN` is one `DataType`, and nothing in it distinguishes a column that can be null from one that cannot. Nullability is a property of the data, tracked at run time by the null bitmap from [chapter 4](../00-orientation/04-rows-columns-and-chunks.md), and every optimizer pass that reasons about nulls has to derive it rather than look it up.

The interesting inference rule is arithmetic.

## Arithmetic

[`inferArithmeticType`](../../src/binder/type-inference.ts), in full:

```typescript
export function inferArithmeticType(left: DataType | null, right: DataType | null, op: string): DataType {
  const leftTemporal = left !== null && isTemporal(left);
  const rightTemporal = right !== null && isTemporal(right);
  if (leftTemporal && rightTemporal) return op === '-' ? DataType.INT32 : left!;
  if (leftTemporal) return left!;
  if (rightTemporal) return right!;
  if (op === '/') return DataType.FLOAT64;
  if (left === DataType.FLOAT64 || right === DataType.FLOAT64) return DataType.FLOAT64;
  if (left === DataType.DECIMAL || right === DataType.DECIMAL) return DataType.DECIMAL;
  if (WIDENING_ARITHMETIC_OPS.has(op)) return DataType.INT64;
  if (left === DataType.INT64 || right === DataType.INT64) return DataType.INT64;
  return DataType.INT32;
}
```

Nine lines, checked in order. Each one earns its place.

Measured against a table with an `INT32`, a `FLOAT64`, a `VARCHAR`, and a `DATE` column:

| Expression | Type | Rule |
|---|---|---|
| `I + I` | `INT64` | widening |
| `I - I` | `INT64` | widening |
| `I * I` | `INT64` | widening |
| `I / I` | `FLOAT64` | division is always float |
| `F + I` | `FLOAT64` | float infects |
| `D - D` | `INT32` | date difference is a count of days |
| `D + I` | `DATE` | date plus a number is a date |
| `I > 1` | `BOOLEAN` | comparison |
| `I = I AND I = I` | `BOOLEAN` | logical |
| `S \|\| S` | `VARCHAR` | concatenation |

### Division is never integer division

```typescript
if (op === '/') return DataType.FLOAT64;
```

Unconditional, before any operand type is examined. `INT32 / INT32` is `FLOAT64`.

The argument for this behavior is that `5 / 2 = 2` surprises far more people than it helps, and silently discards data. The argument against is that it diverges from the SQL standard and from PostgreSQL, so a query ported from elsewhere can produce different numbers without any error — the worst kind of incompatibility. Both arguments are real. What matters for you is knowing which side this engine picked, because the plan will never tell you.

### Addition, subtraction, and multiplication widen

```typescript
if (WIDENING_ARITHMETIC_OPS.has(op)) return DataType.INT64;
```

`WIDENING_ARITHMETIC_OPS` is `+`, `-`, `*`. Two `INT32`s added give an `INT64`, even though the sum of two 32-bit values usually fits in 32 bits.

This trades memory for the elimination of a whole failure mode. `SUM` over a million rows of `INT32` overflows easily; a product of two large `INT32`s overflows almost immediately. Widening at the type level means the overflow never happens rather than being detected after the fact — and since `INT64` is a `BigInt64Array` in storage, the wider result is genuinely exact rather than drifting into float imprecision.

The cost is that intermediate values are eight bytes instead of four, and that a chain of arithmetic stays wide even when it did not need to. This engine takes correctness here, and it is the same reason [`inferAggregateType`](../../src/binder/type-inference.ts) makes `SUM` of any integer type return `INT64`.

### Temporal arithmetic

Three lines handle dates, and their order encodes real semantics:

```typescript
if (leftTemporal && rightTemporal) return op === '-' ? DataType.INT32 : left!;
if (leftTemporal) return left!;
if (rightTemporal) return right!;
```

Date minus date is a **number of days** (`INT32`), not a date — subtracting two points gives an interval. Date plus a number is still a date. And because the temporal checks come first, they beat every other rule: `DATE + FLOAT64` is a `DATE`, not a float.

Recall from chapter 4 that a `DATE` is an `Int32Array` of day numbers. Date arithmetic is therefore integer arithmetic that happens to be labeled — the type system carries the meaning, and the execution layer never converts to a calendar object.

## Aggregates

[`inferAggregateType`](../../src/binder/type-inference.ts):

| Aggregate | Result | Why |
|---|---|---|
| `COUNT`, `COUNT(*)` | `INT64` | a count can exceed 2³¹ |
| `AVG` | `FLOAT64` | a mean of integers is not an integer |
| `SUM` of `INT32`/`INT64` | `INT64` | overflow avoidance, as above |
| `SUM` of anything else | the argument's type | float stays float, decimal stays decimal |
| `MIN`, `MAX` | the argument's type | the result is one of the inputs |
| anything with a null argument type | `FLOAT64` | the fallback, discussed below |

Verified: `SUM(I) -> INT64`, `AVG(I) -> FLOAT64`, `COUNT(*) -> INT64`, `MIN(S) -> VARCHAR`, `MAX(F) -> FLOAT64`.

`MIN` and `MAX` returning the argument type is what lets `MIN` work on strings at all. But look at the last row. Every branch that consults `argType` guards against its being null by falling back to `FLOAT64` — `if (!argType) return DataType.FLOAT64` for `SUM`, `argType ?? DataType.FLOAT64` for `MIN` and `MAX`, and a `default` arm that does the same for any aggregate name the switch does not recognize. An aggregate over an argument of unknown type is therefore *guessed* as a float rather than rejected, which is a place where an unusual query gets a surprising type instead of an error.

## Typing literals

[`bindLiteral`](../../src/binder/binder.ts) turns a parser literal into a typed one. Chapter 7 showed the parser leaves integers untyped; here is where that is resolved:

```typescript
if (typeof node.value === 'number') {
  if (Number.isInteger(node.value)) {
    return BE.BoundLiteral(node.value, DataType.INT32);
  }
  return BE.BoundLiteral(node.value, DataType.FLOAT64);
}
```

An integral numeric literal is `INT32`; anything else is `FLOAT64`. `NULL` gets a `null` type — it has no type of its own and takes meaning from context.

Date and timestamp literals are converted here too, from text to the integer representation storage uses:

```typescript
if (node.dataType === 'DATE') {
  const [y, m, d] = (node.value as string).split('-').map(Number);
  return BE.BoundLiteral(dateToEpochDays(y, m, d), DataType.DATE);
}
```

[`dateToEpochDays`](../../src/storage/data-type.ts) runs once, at bind time, not once per row. This is a small instance of a large principle: **anything that can be computed during compilation should not be computed during execution.** Part 3 is full of larger instances.

Parameters take their type from the value supplied:

```typescript
bindParameter(node: AST.ParameterNode): BE.BoundLiteralNode {
  if (node.index < 1 || node.index > this.params.length) {
    throw new Error(`Missing value for parameter $${node.index}`);
  }
  const value = this.params[node.index - 1];
  return BE.BoundLiteral(value, valueDataType(value));
}
```

Which means `$1` is not a hole in a plan — by the time a plan exists, the parameter is a literal of a known type. That has a consequence worth flagging early: the plan cache in [`query-engine.ts`](../../src/engine/query-engine.ts) keys on the SQL text **and** the serialized parameters, because the same SQL with different parameters may deserve a different plan.

## Reading a type back

Every bound node carries its own type, and [`getExprType`](../../src/binder/expression-binder.ts) is the accessor that hides where each node keeps it — `resultType` on most, `dataType` on literals and casts. Anything asking "what type is this expression" goes through it rather than reaching into fields.

## Two helpers the optimizer runs on

Binding also produces two small utilities that Part 3 uses constantly. They live here because they operate on bound expressions, and they are worth meeting now.

**Splitting conjunctions.** [`splitConjuncts`](../../src/binder/conjuncts.ts) flattens an `AND` tree into an array, and [`combineConjuncts`](../../src/binder/conjuncts.ts) rebuilds one:

```typescript
export function splitConjuncts(expr: BoundExpr | null): BoundExpr[] {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op?.toUpperCase() === AND) {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}
```

`a AND b AND c` becomes three independent predicates. Each of those pieces is a **conjunct** — one top-level `AND`-separated term of a condition — and the word is worth learning here, because from Part 3 onward the optimizer almost never reasons about a `WHERE` clause as a whole. It reasons about conjuncts. [Chapter 17](../03-optimizer/17-predicate-pushdown.md) shows why: the three pieces of a `WHERE` clause frequently belong in three different places in the plan, and being able to move them separately is what makes predicate pushdown possible at all.

**Structural identity.** [`exprKey`](../../src/binder/expr-key.ts) produces a canonical string for an expression:

```typescript
[BoundExprKind.COLUMN_REF]: (e) => `col(${(node.tableAlias || '').toUpperCase()}.${node.columnName.toUpperCase()})`,
[BoundExprKind.BINARY]:     (e) => `bin(${node.op},${exprKey(node.left)},${exprKey(node.right)})`,
```

Two expressions are "the same" if their keys match. That is how `checkGroupingCoverage` in chapter 8 knew that a select-list expression matched a grouping key, how the optimizer removes duplicate predicates, and how a `GROUP BY` finds its aggregates. Results are memoized in a `WeakMap`, so repeated keying of a large tree is cheap and the cache disappears with the tree.

Chapter 8 noted that repeated aliases get shadow names like `CUSTOMER:1`. This is where that matters: `exprKey` builds identity out of `tableAlias.columnName`, so two genuinely different columns sharing a user-written alias would produce the same key and be treated as equal. The uniqueness the binder enforces is what keeps this string-keyed equality sound.

## In the code

| Thing | Where |
|---|---|
| All inference rules | [`src/binder/type-inference.ts`](../../src/binder/type-inference.ts) |
| Arithmetic | [`inferArithmeticType`](../../src/binder/type-inference.ts) |
| Aggregates | [`inferAggregateType`](../../src/binder/type-inference.ts) |
| Literal typing | [`bindLiteral`](../../src/binder/binder.ts) |
| Parameters | [`bindParameter`](../../src/binder/binder.ts) |
| Date conversion | [`dateToEpochDays`](../../src/storage/data-type.ts) |
| Type accessor | [`getExprType`](../../src/binder/expression-binder.ts) |
| Conjunction splitting | [`splitConjuncts`](../../src/binder/conjuncts.ts) |
| Structural identity | [`exprKey`](../../src/binder/expr-key.ts) |

## Traps

**`5 / 2` is `2.5`.** A query ported from PostgreSQL that relies on integer division produces different numbers with no error.

**Integer arithmetic silently widens to `INT64`.** `INT32 + INT32` is `INT64`, which is a `BigInt64Array` in storage — so a column read through [`get`](../../src/storage/column.ts) or [`getValue`](../../src/storage/chunk.ts) hands back a `bigint`, and `1n === 1` is false. Operator code has to expect that. Query *results* do not: `engine.run` converts on the way out, so `SELECT I + I` arrives as a JavaScript `number`. The trap is that the two layers disagree, and only one of them is the one you are usually looking at.

**`NULL` has a null type.** Not a type called "null" — the field is `null`. Every consumer of `dataType` must handle its absence, and `inferArithmeticType` explicitly guards `left !== null` before its temporal checks.

**Temporal rules beat everything.** `DATE + FLOAT64` is a `DATE`. If you add a fractional number of days to a date, the type system will not warn you.

**`exprKey` equality is structural, not semantic.** `a + b` and `b + a` have different keys. Passes that want to see through commutativity have to canonicalize first, which is part of what `ExpressionSimplifier` does in chapter 16.

## Exercises

1. Reproduce the type table. Bind `SELECT <expr> AS R FROM T` and read `outputColumns[0].dataType` for each expression.

2. Change division to return `INT32` when both operands are integers. Run `npm run test:e2e`. Count the failures, and decide whether each is a test that pinned a deliberate decision or one that happened to depend on it.

3. `SUM(I)` returns `INT64`. Write a query where that matters — the sum of `INT32` values genuinely exceeding 2³¹ — and confirm the answer is exact.

4. `D + I` is a `DATE`. What does the *execution* layer do with the fractional part if `I` is a float? Find the code, and decide whether the type rule or the evaluator should be the one to complain.

5. Compute `exprKey` for `a + b` and `b + a`. They differ. Write down what a pass would have to do to treat them as equal, and what it would break.

## Recap

- Expression types are the same **eight storage types**; all inference is in one 45-line file.
- `BOOLEAN` carries **three values** — `TRUE`, `FALSE`, and `NULL` for unknown — and `WHERE` keeps only `TRUE`, which is where every null surprise in this book starts. The type system does not record nullability at all.
- **Division always yields `FLOAT64`** — `5 / 2` is `2.5`, diverging from the SQL standard by choice.
- `+`, `-`, `*` on integers **widen to `INT64`** to eliminate overflow, and `SUM` of an integer does the same.
- **Temporal rules are checked first**: date minus date is a day count (`INT32`), date plus a number is a date.
- Literals are typed at bind time — date literals are **converted to integers during compilation**, not per row, and **parameters become typed literals**, which is why the plan cache keys on parameter values as well as SQL text.
- [`splitConjuncts`](../../src/binder/conjuncts.ts) and [`exprKey`](../../src/binder/expr-key.ts) are the two small utilities the optimizer leans on hardest — one to reason about `AND`ed predicates independently, one to decide when two expressions are the same.

That completes Part 1. The query is now a fully resolved, fully typed tree that still mirrors the shape of the SQL you wrote. Next: Part 2 throws that shape away and [rebuilds the query as relational algebra](../02-logical-plan/10-relational-algebra.md).
