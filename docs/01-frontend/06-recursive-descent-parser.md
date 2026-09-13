# 6. A recursive-descent parser

> After this chapter you will be able to read the parser's precedence ladder, explain why `a + b * 2` groups correctly without any precedence table, and say why `a = b = c` is a syntax error here.

## The question

The lexer handed us a flat list. `SELECT`, `IDENT`, `PLUS`, `IDENT`, `STAR`, `NUMBER`. Flat lists do not have structure, and this expression has two possible structures:

```
(a + b) * 2          a + (b * 2)
```

Multiplication binds more tightly than addition, so the second grouping gives the usual arithmetic meaning. The question is how a program knows, and the answer this parser gives involves no precedence table, no operator stack, and no grammar generator. It is 1,048 lines of ordinary functions calling each other, in [`src/parser/parser.ts`](../../src/parser/parser.ts).

## One function per precedence level

The technique is called recursive descent, and the core of it fits in a paragraph: **write one function per precedence level, and have each one call the level that binds tighter.**

Here is the chain, from loosest to tightest:

```
parseExpression
  parseOr              OR
    parseAnd           AND
      parseNot         NOT
        parseComparison  =  <>  <  >  <=  >=  IN  LIKE  BETWEEN  IS
          parseAddition      +  -  ||
            parseMultiplication  *  /  %
              parseUnary           -x  NOT x
                parsePrimary         literals, columns, function calls, ( ... )
```

And here is a level, in full:

```typescript
parseOr(): AST.Expr {
  let left = this.parseAnd();
  while (this.isAt(TokenType.OR)) {
    this.advance();
    const right = this.parseAnd();
    left = AST.BinaryExpr('OR', left, right);
  }
  return left;
}
```

Every level has this shape. Parse one operand at the next-tighter level, then loop while the current level's operator appears, parsing another tighter operand each time.

Follow `a + b * 2` down. [`parseAddition`](../../src/parser/parser.ts) calls [`parseMultiplication`](../../src/parser/parser.ts), which calls `parseUnary` and `parsePrimary` and comes back with `a` — it stopped because the next token is `+`, which is not a multiplication operator. `parseAddition` sees the `+`, consumes it, and asks `parseMultiplication` for the right operand. *That* call sees `b`, then `*`, then `2`, and builds `b * 2` before returning. So `parseAddition` receives the whole product as one operand and builds `a + (b * 2)`.

The precedence is not encoded in a table. It is encoded in **which function calls which**, and the deeper function wins because it finishes first. Verified against the real AST:

```json
{ "kind": "BinaryExpr", "op": "+",
  "left":  { "kind": "ColumnRef", "name": "a" },
  "right": { "kind": "BinaryExpr", "op": "*",
             "left":  { "kind": "ColumnRef", "name": "b" },
             "right": { "kind": "Literal", "value": 2 } } }
```

### Associativity comes free

`1 - 2 - 3` must be `(1 - 2) - 3`, not `1 - (2 - 3)` — those differ by four. Nothing in the parser mentions associativity, yet it comes out right:

```
1 - 2 - 3  ->  left is BinaryExpr | right is Literal | op -
```

The left operand is itself a subtraction; the right is the bare literal `3`. That falls out of `left = AST.BinaryExpr(op, left, right)` inside the `while` loop: each iteration wraps everything accumulated so far as the *left* child. A loop that reassigns `left` is a left-associative operator. Recursing instead of looping would make it right-associative, which is what you would do for exponentiation.

## Comparisons do not chain

[`parseComparison`](../../src/parser/parser.ts) breaks the pattern. It has no `while` loop:

```typescript
if (opMap[this.peek().type]) {
  const op = opMap[this.advance().type];
  ...
  const right = this.parseAddition();
  return AST.BinaryExpr(op, left, right);
}
```

One comparison operator, then return. So `a = b = c` consumes `a = b` and hands control back with `= c` still in the stream, and nothing above knows what to do with it:

```
SELECT a = b = c FROM T
  -> Parse error at line 1, column 14: Unexpected token EQ
```

This is deliberate and matches the SQL standard. In C, `a == b == c` is legal and means comparing a boolean to `c`, which is almost never intended. Making it a syntax error costs one omitted loop and removes a class of silent bugs.

## Where recursive descent needs help

The textbook version of this technique decides everything from the next token and never backs up. Real SQL does not cooperate, and this parser handles the gaps in two ways.

### Backtracking on NOT

`NOT` is ambiguous. It might negate a whole expression (`NOT a > 5`), or it might be part of a compound operator (`a NOT BETWEEN 1 AND 5`, `a NOT IN (...)`, `a NOT LIKE '%x'`). You cannot tell until you have consumed the `NOT` and looked at what follows.

So the parser consumes it and puts it back if it guessed wrong:

```typescript
if (this.isAt(TokenType.NOT)) {
  const saved = this.pos;
  this.advance();
  if (this.isAt(TokenType.BETWEEN)) {
    return this.parseBetween(left, true);
  } else if (this.isAt(TokenType.IN)) {
    return this.parseIn(left, true);
  } else if (this.isAt(TokenType.LIKE)) {
    return this.parseLike(left, true);
  }
  this.pos = saved;
}
```

Saving an integer and restoring it is the whole backtracking mechanism, and it works because the parser's entire state is one index into a token array. Nothing has been built yet at that point, so there is nothing to undo. Confirmed on real input:

```
a NOT BETWEEN 1 AND 5   -> BetweenExpr negated=true
NOT a > 5               -> UnaryExpr op=NOT
a NOT IN (1,2)          -> InExpr negated=true
```

Note that the negation is folded into the node — a `BetweenExpr` with `negated: true`, not a `NOT` wrapped around a `BetweenExpr`. That keeps the optimizer from having to see through a layer later.

### Unbounded lookahead

An open parenthesis in SQL might begin a grouped expression, a list, or a subquery, and the distinguishing token can be arbitrarily far away. [`isSubqueryStart`](../../src/parser/parser.ts) scans forward, tracking depth, looking for a `SELECT`, `WITH`, or `FROM` at nesting level one:

```typescript
isSubqueryStart(): boolean {
  let depth = 0;
  for (let i = this.pos; i < this.tokens.length; i++) {
    if (this.tokens[i].type === TokenType.LPAREN) depth++;
    if (this.tokens[i].type === TokenType.RPAREN) depth--;
    if (depth === 0 && i > this.pos) break;
    if (depth === 1 && (... SELECT || WITH || FROM)) return true;
  }
  return false;
}
```

This is why chapter 5 mentioned that the lexer tokenizes eagerly into an array. A streaming lexer would make this scan impossible without buffering, and the parser would need a different design. One decision in a 316-line file shaped a 1,048-line one.

## Keywords you can still use as names

Chapter 5 ended on a limitation: no quoted identifiers, so a column cannot be named like a keyword. That is true, but the parser softens it considerably. [`expectIdent`](../../src/parser/parser.ts) accepts an `IDENT` *or* anything in [`isNonReservedKeyword`](../../src/parser/parser.ts) — a list of 58 keywords that are only contextually special:

```typescript
if (this.isNonReservedKeyword(token.type)) {
  this.advance();
  return token.value;
}
```

`YEAR`, `COUNT`, `ROWS`, `LEFT`, `TABLE`, `RANGE`, and 52 others are on it. The effect is precise, and worth pinning down because it is easy to get wrong from a description:

| Query | Result |
|---|---|
| `SELECT * FROM YEAR` | works — table name goes through `expectIdent` |
| `SELECT a AS YEAR FROM T` | works — alias goes through `expectIdent` |
| `SELECT t.YEAR FROM T t` | works — the name after `.` goes through `expectIdent` |
| `SELECT YEAR FROM T` | **fails** — a bare column reference is dispatched by token type |

The difference is that the first three positions are places where the parser has already decided it needs a name and calls `expectIdent`. A bare expression is not such a place: [`parsePrimary`](../../src/parser/parser.ts) switches on the token type, and a `YEAR` token is not `IDENT`, so it falls through to the error. The fix for a user is to qualify it — `t.YEAR` — which is a real workaround rather than a satisfying one.

Genuinely reserved words behave as you would expect:

```
SELECT SELECT FROM T  -> Parse error at line 1, column 8: Unexpected token SELECT (SELECT)
SELECT WHERE FROM T   -> Parse error at line 1, column 8: Unexpected token WHERE (WHERE)
```

## Statements

The expression grammar gets the attention, but most of the parser is statement structure: [`parseSelectStmt`](../../src/parser/parser.ts) reads clauses in order, [`parseFromClause`](../../src/parser/parser.ts) and [`parseJoin`](../../src/parser/parser.ts) build the from-tree, [`parseWithClause`](../../src/parser/parser.ts) handles CTEs, [`parseQueryExpr`](../../src/parser/parser.ts) handles `UNION` and friends.

One structural detail matters later. Joins are parsed **left-associatively into a tree**, so `A JOIN B JOIN C` becomes `(A JOIN B) JOIN C`. That shape is what the optimizer's join reordering pass in chapter 25 spends its time rearranging — and the fact that the parser's shape is arbitrary is exactly why that pass exists.

The small helpers do the bookkeeping: [`peek`](../../src/parser/parser.ts) looks without consuming, [`advance`](../../src/parser/parser.ts) consumes and returns, [`tryConsume`](../../src/parser/parser.ts) consumes only if the type matches, and [`expect`](../../src/parser/parser.ts) consumes or throws:

```typescript
expect(type: TokenType): Token {
  if (!this.isAt(type)) {
    this.error(`Expected ${type}, got ${this.peek().type} (${this.peek().value})`);
  }
  return this.advance();
}
```

Every syntax error in the engine comes from `expect`, `expectIdent`, or a `default` branch, and every one of them carries the position the lexer recorded:

```
SELECT a FROM   -> Parse error at line 1, column 14: Expected identifier, got EOF ()
SELECT FROM T   -> Parse error at line 1, column 8: Unexpected token FROM (FROM)
```

## In the code

| Thing | Where |
|---|---|
| Entry point | [`parse`](../../src/parser/parser.ts) |
| The parser | [`Parser`](../../src/parser/parser.ts) |
| Precedence ladder | [`parseExpression`](../../src/parser/parser.ts) down to [`parsePrimary`](../../src/parser/parser.ts) |
| Comparison, non-chaining | [`parseComparison`](../../src/parser/parser.ts) |
| Backtracking | the `saved` index in [`parseComparison`](../../src/parser/parser.ts) |
| Arbitrary lookahead | [`isSubqueryStart`](../../src/parser/parser.ts), [`isLookaheadSelect`](../../src/parser/parser.ts) |
| Contextual keywords | [`isNonReservedKeyword`](../../src/parser/parser.ts) |
| Error reporting | [`expect`](../../src/parser/parser.ts), [`expectIdent`](../../src/parser/parser.ts) |

## Traps

**Precedence lives in the call graph.** To change how tightly an operator binds you move it between functions, not edit a number. Adding an operator at the wrong level produces a parser that accepts everything and groups it wrongly — which no test of *valid* queries will catch, only tests of *structure*.

**Backtracking only works before anything is built.** `this.pos = saved` restores the token index and nothing else. Introducing a backtrack after a node has been constructed, or after a side effect, would leave that state behind.

**Non-reserved keywords work in name positions only.** The four-row table above is the whole rule. Do not simplify it to "these keywords are usable as identifiers".

**The parser does not know whether anything exists.** `SELECT nope FROM nosuchtable` parses without complaint. Every error in this chapter is about *shape*. Chapter 7 is about why that is not enough.

## Recap

- **Recursive descent** encodes operator precedence in the **call graph**: one function per level, each calling the tighter one.
- **Left associativity** comes from the `while` loop that reassigns `left`; recursion instead would give right associativity.
- Comparisons **do not chain** — `parseComparison` handles at most one operator, making `a = b = c` a syntax error by design.
- The parser **backtracks** by saving and restoring a token index, which works because nothing has been constructed yet.
- It uses **unbounded lookahead** to tell a subquery from a parenthesized expression, which is only possible because the lexer produced an array.
- **Non-reserved keywords** are accepted where the parser explicitly asks for a name, but not as bare column references.
- Every error here is about **syntax**. Nothing has been checked against a real table.

Next: [chapter 7](07-the-ast-and-its-limits.md) takes the tree we just built and shows precisely what it cannot tell us.
