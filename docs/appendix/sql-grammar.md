# SQL dialect reference

This is a guide to the parser in this repository, not a claim of full SQL conformance. Parsing establishes a structure; binding, planning, and execution may impose further restrictions. Start with the tested examples in [chapter 2](../00-orientation/02-running-it-yourself.md), then use this reference to find the relevant source.

## Query shape

The following is an abbreviated grammar. Square brackets mean optional, braces mean repetition, and `expression` stands for the expression grammar described below. This notation is explanatory, not a parser generator input.

```text
statement := [EXPLAIN [ANALYZE]] query
           | CREATE TABLE [IF NOT EXISTS] name (column type, ...)
           | CREATE TABLE [IF NOT EXISTS] name AS query
           | DROP TABLE [IF EXISTS] name

query     := query-term { (UNION | EXCEPT) [ALL | DISTINCT] query-term } tail
query-term := select { INTERSECT [ALL | DISTINCT] select }
select    := [WITH cte {, cte}] (
               SELECT [DISTINCT | ALL] item {, item}
               [FROM relation]
               [WHERE expression]
               [GROUP BY expression {, expression}]
               [HAVING expression]
             | (query)
             )
cte       := name [(column {, column})] AS (query)
item      := * | name.* | expression [[AS] alias]
tail      := [ORDER BY order-key {, order-key}]
             [LIMIT expression [OFFSET expression]]
             [FETCH [FIRST | NEXT] expression [ROWS] ONLY]
order-key := expression [ASC | DESC] [NULLS FIRST | NULLS LAST]
```

`INTERSECT` binds more tightly than `UNION` and `EXCEPT`. Parentheses can make the intended grouping explicit. The parser also accepts a `FROM relation` shorthand for `SELECT * FROM relation`. `WITH` has additional placement restrictions around parenthesized set operations; consult `parseSelectStmt` for those cases.

Pass **one statement per engine call**. The parser accepts a semicolon as a terminator, but does not execute a script of statements after it. Do not use successful parsing as evidence that a trailing statement ran.

## Relations and joins

Relations include named tables, derived queries in parentheses, and joins. Supported join syntax includes `JOIN`, `INNER JOIN`, `LEFT`, `RIGHT`, and `FULL` with optional `OUTER`, and `CROSS JOIN`. Ordinary join conditions use `ON expression` or `USING (column, ...)`; `NATURAL` derives common columns. Comma-separated relations form cross joins.

Give derived tables explicit aliases. A dotted table reference is accepted syntactically, but the parser keeps its final name; this is not a multi-catalog or multi-schema namespace implementation.

SQL join syntax and physical join algorithms are separate. `LEFT JOIN` describes preserved rows; hash, merge, and nested loop describe ways of finding matches. See [chapter 35](../04-execution/35-other-joins.md).

## Expressions

From weaker to stronger binding, the main expression levels are `OR`, `AND`, unary `NOT`, comparisons, concatenation (`||`), addition/subtraction, multiplication/division/remainder, unary signs, and primary expressions. Parentheses override this order.

Primary expressions and predicates include:

- Integer, decimal, exponent, string, boolean, and `NULL` literals; column references; positional parameters such as `$1`.
- `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, `IS NULL`, truth tests, `BETWEEN`, `LIKE`, and `IN`, including their supported negated forms.
- Scalar subqueries, `EXISTS`, and quantified comparisons with `ANY`, `SOME`, and `ALL`.
- Searched and simple `CASE`, `CAST`, date/interval expressions, and function calls.
- Aggregate calls such as `COUNT(*)`, `SUM`, `AVG`, `MIN`, and `MAX`, with distinct aggregation where supported.
- Window calls with `OVER (...)`, optional `PARTITION BY`, ordering, and `ROWS`, `RANGE`, or `GROUPS` frames. Bounds include unbounded, current row, and an offset preceding/following; `BETWEEN` supplies both ends.

A function-shaped expression can parse even if no corresponding function is registered. Likewise, `type` accepts a name and optional numeric parameters; the binder determines whether it is a supported type. Use [chapter 9](../01-frontend/09-types-and-expressions.md) for types and coercion, and [chapter 38](../04-execution/38-window-functions.md) for frame semantics and execution limits.

## Lexical rules

Keywords are case-insensitive. Ordinary identifiers start with an ASCII letter or underscore and continue with letters, digits, or underscores. Double quotes delimit identifiers and preserve a quoted flag: `"order total"`. Double a quote inside a quoted name to include it. Single quotes delimit strings; `'it''s'` contains one apostrophe.

Numbers start with a digit: write `0.5`, not `.5`. An exponent such as `1.5e-2` is supported. A leading `-` is a separate operator. Comments use `--` through end of line or nested `/* ... */`. Consequently, `5--3` starts a comment; use `5 - -3` for subtraction of a negative number.

## Boundaries to keep in mind

- This parser does not implement `INSERT`, `UPDATE`, `DELETE`, transaction statements, `CREATE VIEW`, or recursive CTEs. A token named `VIEW` does not imply a `CREATE VIEW` statement exists.
- Column definitions in `CREATE TABLE` are names and types, not a full SQL constraint language. Metadata supplied through APIs has its own contract.
- `OFFSET` is consumed after `LIMIT`; standalone `OFFSET` is not the query-tail form above. Prefer a non-negative integer literal for `LIMIT` and `OFFSET`; accepting an expression in the parser does not guarantee that the logical planner evaluates it.
- A select-list alias is available in supported later clauses such as `ORDER BY`, but not as a new input column in `WHERE`.
- Correlated subqueries must fit the implemented decorrelation rules. Unsupported forms can raise an error. Scalar subqueries also have documented differences from standard multi-row error behavior; see [chapter 26](../03-optimizer/26-subquery-unnesting.md).

## Source of truth

| Subject | Source |
|---|---|
| Tokens, literals, comments | [`Lexer`](../../src/parser/lexer.ts) |
| Statements and expression precedence | [`Parser`](../../src/parser/parser.ts) |
| Syntax tree shapes | [AST definitions](../../src/parser/ast.ts) |
| Name and type resolution | [Binder](../../src/binder/binder.ts) |
| Semantic examples you can run | [semantics.mjs](../examples/semantics.mjs) |

For a suspected dialect gap, reduce it to one query and record whether it fails in parsing, binding, planning, or execution. [Chapter 53](../07-surfaces/53-debugging.md) shows that workflow.
