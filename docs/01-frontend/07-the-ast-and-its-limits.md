# 7. The AST and why it isn't enough

> After this chapter you will be able to state exactly what information a syntax tree is missing, and why a separate stage — not a bigger parser — is the right way to supply it.

## The question

This query parses cleanly:

```sql
SELECT NOPE FROM NOSUCH
```

No error, no warning. The parser produces a perfectly well-formed node:

```json
{ "kind": "ColumnRef", "name": "NOPE", "table": null }
```

It is a valid English sentence about an imaginary world. The grammar is satisfied; nothing else has been consulted. This chapter is about the gap between *well-formed* and *meaningful*, because that gap is the entire justification for the next stage of the pipeline.

## What the tree actually holds

[`src/parser/ast.ts`](../../src/parser/ast.ts) defines 37 node types. They are plain data — interfaces, not classes, with no methods and no behavior:

```typescript
export interface ColumnRefNode { kind: NodeKind.COLUMN_REF; name: string; table: string | null; }
export interface LiteralNode { kind: NodeKind.LITERAL; value: string | number | boolean | null; dataType: DataType | null; }
export interface BinaryExprNode { kind: NodeKind.BINARY_EXPR; op: string; left: Expr; right: Expr | QuantifiedSubqueryNode; }
```

Every node carries a `kind` field, and [`Expr`](../../src/parser/ast.ts) is the union of expression nodes. That discriminated-union shape is what makes every consumer a `switch` on `kind` — the binder, the formatter, and the tests all walk the tree the same way.

The tree mirrors the *syntax*. `SELECT` items are a list because the grammar has a list; `WHERE` is one expression because the grammar has one expression; a join is a node with a left and a right because that is how joins are written. Nothing has been rearranged, resolved, or checked.

## Four things it cannot tell you

### Does this name refer to anything?

`ColumnRefNode` holds two strings. It does not hold a table, a column, a position, or a type — because at parse time none of those exist. There is no catalog in scope, and deliberately so: a parser that consulted a catalog could not be tested without one, could not parse a query against a table that had not been created yet, and would mix two failure modes into one error message.

So `NOPE` and `C_NAME` are the same kind of node with different strings in them.

### Which table does an unqualified column belong to?

```sql
SELECT C_NAME FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
```

`C_NAME` has `table: null`. Answering *which side* requires knowing both tables' column lists, then checking that exactly one of them has a `C_NAME` — and reporting an ambiguity error if both do. That is a lookup against real schemas, which is not a parsing problem.

### What type is this?

The parser tags some literals and not others:

```json
{"kind":"Literal","value":1,     "dataType":null}
{"kind":"Literal","value":1.5,   "dataType":"FLOAT64"}
{"kind":"Literal","value":"x",   "dataType":"VARCHAR"}
{"kind":"Literal","value":null,  "dataType":null}
{"kind":"Literal","value":true,  "dataType":"BOOLEAN"}
```

The integer `1` has no type. Neither does `NULL`. And no expression node has a type at all — `a + b` is a `BinaryExprNode` with an `op` string, and whether that addition yields an integer, a float, or a date depends entirely on what `a` and `b` turn out to be. Chapter 9 works through the rules; the point here is that they cannot run until names are resolved.

### How wide is `*`?

```json
{ "kind": "AllColumns", "table": null }
```

One node. A query returning forty columns and a query returning two have identical syntax trees at this point. `t.*` is the same node with `table: "t"`. Expanding it means asking the catalog what columns exist and in what order, and the order matters — it determines the shape of every row the query returns.

## The trap: syntax that means two different things

Here is the sharpest illustration. These two `ORDER BY` clauses produce **byte-identical** AST fragments apart from the name:

```json
ORDER BY NM       -> {"kind":"ColumnRef","name":"NM","table":null}
ORDER BY C_NAME   -> {"kind":"ColumnRef","name":"C_NAME","table":null}
```

But in `SELECT C_NAME AS NM FROM CUSTOMER ORDER BY NM`, the first one is not a column at all — it is a reference to a select-list alias, and it must resolve to the *expression* `C_NAME`, not to a column named `NM` (which does not exist). The second is an ordinary column reference.

**The same syntax means different things depending on context that the tree does not record.** No amount of care in the parser fixes this, because the disambiguating information — the select list's aliases — is somewhere else in the tree entirely. Resolving it requires walking the query in a particular order with an accumulated environment, which is exactly what a binder is.

And it gets worse in a useful way: `ORDER BY 2` is a `LiteralNode`, and it means "the second select item", not the number two.

## Why not make the parser smarter?

Every gap above could in principle be closed by giving the parser a catalog. Three reasons not to.

**Separation of failure modes.** `SELECT FROM T` and `SELECT nope FROM T` are different kinds of wrong, and users benefit from being told which. Merging the stages merges the messages.

**The parser has no order of operations.** The binder needs to process `FROM` before the select list before `ORDER BY`, because each stage builds the environment the next one resolves against. The parser must process clauses in *written* order. Those are different traversals of the same tree, and one function cannot do both cleanly.

**Reusability.** The DataFrame API in chapter 50 builds queries without any SQL text. It skips the parser entirely and produces bound expressions directly. If name resolution and type inference lived in the parser, that whole surface would have to reimplement them — or the engine would need two subtly different versions of the type rules, which is how dialects grow bugs.

## What the next stage produces

The binder's output is a parallel tree of `Bound*` nodes in [`src/binder/expression-binder.ts`](../../src/binder/expression-binder.ts). Compare the same column reference before and after:

```typescript
// AST
interface ColumnRefNode { kind: NodeKind.COLUMN_REF; name: string; table: string | null; }

// Bound
interface BoundColumnRefNode {
  kind: BoundExprKind.COLUMN_REF;
  tableAlias: string;
  columnName: string;
  columnIndex: number;
  dataType: DataType | null;
  depth: number;
  isCorrelated: boolean;
}
```

Two strings become six fields. `table` is no longer null — every reference is qualified. `columnIndex` is the position in the source relation, so execution can index an array rather than look up a name. `dataType` is filled in. And `depth` records how many query boundaries were crossed to find the column, which is how a **correlated** subquery is detected — the fact that chapter 27 builds its entire decorrelation strategy on.

Note what is *not* different: the shape. `BoundExpr` is still a discriminated union walked by `switch`. The binder does not restructure the query; it annotates it. Restructuring is the planner's job, in Part 2.

## In the code

| Thing | Where |
|---|---|
| All AST node types | [`src/parser/ast.ts`](../../src/parser/ast.ts) |
| Expression union | [`Expr`](../../src/parser/ast.ts) |
| Unresolved column reference | [`ColumnRefNode`](../../src/parser/ast.ts) |
| Star | [`AllColumnsNode`](../../src/parser/ast.ts) |
| Resolved column reference | [`BoundColumnRefNode`](../../src/binder/expression-binder.ts) |
| Bound expression union | [`BoundExpr`](../../src/binder/expression-binder.ts) |
| Bound node kinds | [`BoundExprKind`](../../src/binder/expression-binder.ts) |

## Traps

**A parsed query is not a valid query.** Anything that accepts SQL from users and reports "syntax OK" has checked almost nothing.

**AST node types and bound node types have similar names and different meanings.** `NodeKind.COLUMN_REF` and `BoundExprKind.COLUMN_REF` are distinct enums for distinct trees. Code that handles one and receives the other typechecks in places where both are structurally loose.

**`dataType` on a `LiteralNode` is a parser hint, not a decision.** It is `null` for integers and for `NULL`. The binder assigns the real type, and chapter 9 shows the rule it uses.

## Exercises

1. Parse `SELECT NOPE FROM NOSUCH` and print the tree. Then bind it and read the error. Which stage produced each, and what does that tell you about where to look when a user reports a problem?

2. Parse `SELECT C_NAME AS NM FROM CUSTOMER ORDER BY NM` and `SELECT 1 FROM T ORDER BY C_NAME`. Diff the `orderBy` fragments. What would you have to add to the AST to distinguish them, and why would it not help?

3. Count the node types in `ast.ts` that exist only to record a keyword that could have been a flag — `BetweenExprNode.negated` is one solution, a `NOT` wrapper would have been another. What does each choice cost the optimizer?

4. `SELECT *` is one node. Write down every piece of information the binder must have to expand it, and in what order.

5. Sketch what would break if `ColumnRefNode` gained a `dataType` field filled in by the parser. Name a query for which the parser could not fill it in correctly.

## Recap

- The AST is **plain data mirroring syntax**, 37 node types, each tagged with a `kind` and walked by `switch`.
- It cannot say whether a name **exists**, which relation an unqualified column **belongs to**, what **type** an expression has, or how many columns `*` **expands to** — all four need a catalog and an ordered traversal.
- The same syntax can mean different things by context: `ORDER BY NM` may be an alias reference, and `ORDER BY 2` is an ordinal.
- Keeping resolution out of the parser separates failure modes, allows a different clause order, and lets the DataFrame API reuse everything below.
- Binding **annotates rather than restructures**: a two-field `ColumnRefNode` becomes a six-field `BoundColumnRefNode`, and `depth` is what will later reveal correlated subqueries.

Next: [chapter 8](08-binder-scopes-and-names.md) builds the environment that answers all four questions.
