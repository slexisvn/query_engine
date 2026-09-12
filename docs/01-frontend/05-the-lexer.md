# 5. The lexer

> After this chapter you will be able to read the token stream for any query, explain how the keyword table maintains itself, and name three pieces of SQL syntax this engine cannot express.

## The question

A query arrives as a string. Not a sentence, not a structure — 55 characters:

```
SELECT c.C_NAME FROM CUSTOMER c WHERE c.C_CUSTKEY >= 10
```

Before anything can ask *what does this mean*, something has to answer *where does one word end*. That `>=` is one operator and not a `>` followed by an `=`. That `CUSTOMER` is a name but `FROM` is a keyword. That the `c` before the dot and the `c` after `CUSTOMER` are the same identifier appearing twice.

That is the lexer's entire job, and it is the smallest interesting component in the engine: [`src/parser/lexer.ts`](../../src/parser/lexer.ts), 316 lines.

## Tokens

A [`Token`](../../src/parser/lexer.ts) is three fields:

```typescript
export class Token {
  type: TokenType;
  value: string;
  position: number;
}
```

Run the query above through [`Lexer`](../../src/parser/lexer.ts) and print what comes out:

```
    0  SELECT       "SELECT"
    7  IDENT        "c"
    8  DOT          "."
    9  IDENT        "C_NAME"
   16  FROM         "FROM"
   21  IDENT        "CUSTOMER"
   30  IDENT        "c"
   32  WHERE        "WHERE"
   38  IDENT        "c"
   39  DOT          "."
   40  IDENT        "C_CUSTKEY"
   50  GTE          ">="
   53  NUMBER       "10"
   55  EOF          ""
```

Fourteen tokens. Whitespace is gone. `>=` is one token, `GTE`. Every token remembers the character offset it started at, which is the only reason a parse error can say *at position 13* rather than *somewhere*.

Note the last one. The lexer always appends an `EOF` token rather than letting the stream run out. That means the parser never has to check whether another token exists — it can always call `peek()` and get something. Removing that one line would put a bounds check in a dozen places.

Note also that the lexer runs to completion in its constructor:

```typescript
constructor(input: string) {
  this.input = input;
  this.pos = 0;
  this.tokens = [];
  this._tokenize();
}
```

The whole query is tokenized up front into an array, not streamed on demand. For a SQL statement that is the right trade — queries are short, and the parser wants to look ahead by an arbitrary number of tokens, which chapter 6 depends on.

## The keyword table builds itself

There are about 110 token types, and roughly 90 of them are SQL keywords. Keeping an enum and a keyword lookup table in sync by hand is the kind of chore that silently breaks — you add `INTERSECT` to the enum, forget the table, and `INTERSECT` lexes as an identifier.

This lexer does not have two lists. It has one, and derives the other:

```typescript
const NON_KEYWORD_TOKENS = new Set([
  'IDENT', 'NUMBER', 'STRING', 'COMMA', 'DOT', 'STAR',
  'LPAREN', 'RPAREN', 'EQ', 'NEQ', 'LT', 'GT', 'LTE', 'GTE',
  'PLUS', 'MINUS', 'SLASH', 'PERCENT', 'SEMICOLON', 'CONCAT', 'COLON', 'PLACEHOLDER', 'EOF',
]);

const KEYWORDS = new Map<string, TokenType>();
for (const key of Object.keys(TokenType)) {
  if (!NON_KEYWORD_TOKENS.has(key)) {
    KEYWORDS.set(key, TokenType[key as keyof typeof TokenType]);
  }
}
```

The exceptions are listed; everything else in the enum is a keyword by construction. Adding `WINDOW` to `TokenType` makes `WINDOW` a keyword with no second edit. The list that has to be maintained is the short one, and it is the one that changes least.

This works because the enum members are spelled exactly like the SQL keywords. That is a deliberate constraint, and it is the sort of small structural decision that determines whether a component stays correct as it grows.

## Reading each kind of thing

[`_tokenize`](../../src/parser/lexer.ts) is a loop that dispatches on the first character:

```typescript
if (ch === "'") {
  this.tokens.push(this._readString(start));
} else if (ch === PLACEHOLDER_PREFIX) {
  this.tokens.push(this._readPlaceholder(start));
} else if (this._isDigit(ch)) {
  this.tokens.push(this._readNumber(start));
} else if (this._isIdentStart(ch)) {
  this.tokens.push(this._readIdentOrKeyword(start));
} else {
  this.tokens.push(this._readSymbol(start));
}
```

One character of lookahead decides everything. Five readers handle the rest.

**Strings.** [`_readString`](../../src/parser/lexer.ts) consumes to the closing quote, with SQL's doubling escape: `''` inside a string produces one `'`. There is no backslash escaping — `'it''s'` is the way to write it. An unterminated string throws with its start position.

**Placeholders.** `$1`, `$2` — a dollar sign followed by digits, producing a `PLACEHOLDER` token carrying the number. This is how parameterized queries avoid string interpolation, and the number is resolved against the supplied parameter array much later, in the binder.

**Numbers.** Digits, optionally a dot, optionally more digits. That is the whole grammar. There is no exponent notation and no sign — `1e10` lexes as the number `1` followed by the identifier `e10`, and `-5` is the `MINUS` operator applied to `5`, which the parser turns into a unary negation.

**Identifiers and keywords.** [`_readIdentOrKeyword`](../../src/parser/lexer.ts) reads a run of letters, digits, and underscores, then makes one decision:

```typescript
const value = this.input.slice(start, this.pos);
const upper = value.toUpperCase();
const keywordType = KEYWORDS.get(upper);
if (keywordType) {
  return new Token(keywordType, upper, start);
}
return new Token(TokenType.IDENT, value, start);
```

Two consequences worth holding on to. Keyword matching is **case-insensitive**, and a keyword token's value is normalized to upper case — so `select`, `Select`, and `SELECT` produce an identical token. But an identifier keeps its original spelling: `c_name` stays `c_name` in the token. Case-insensitive *comparison* of identifiers is not the lexer's problem; it is handled later, in the binder, by uppercasing at lookup time. Chapter 8 shows where.

**Symbols.** [`_readSymbol`](../../src/parser/lexer.ts) is a switch with a small amount of lookahead for the two-character operators. `<` peeks for `=` and `>`, yielding `<=` and `<>`. `>` peeks for `=`. `!` requires a following `=` and throws otherwise, because `!` alone means nothing in this dialect. `|` requires a second `|` to form the concatenation operator.

That is **maximal munch**: at each position, take the longest operator that matches. Without it, `a <= b` would lex as `a < = b` and the parser would report a mysterious error two tokens later.

## Comments, and a sharp edge

[`_skipWhitespaceAndComments`](../../src/parser/lexer.ts) handles spaces, tabs, newlines, and one comment form:

```typescript
if (ch === '-' && this.pos + 1 < this.input.length && this.input[this.pos + 1] === '-') {
  while (this.pos < this.input.length && this.input[this.pos] !== '\n') {
    this.pos++;
  }
  continue;
}
```

Two hyphens start a comment that runs to end of line. There is no `/* ... */` block comment.

Now consider this query:

```sql
SELECT 5--3 FROM T
```

You meant five minus negative three. The lexer sees `5`, then two hyphens, and discards the rest of the line. The result parses cleanly:

```
selectItems: [{"kind":"SelectItem","expr":{"kind":"Literal","value":5,"dataType":null},"alias":null}]
from: null
```

`SELECT 5`. No error, no warning, no `FROM` clause. The fix is a space — `5 - -3` — and the lesson is that a lexer's decisions are invisible by the time anything can complain about them. This is not a bug in this engine; every SQL implementation with `--` comments behaves this way. It is worth meeting once deliberately rather than at 2am.

## What this dialect cannot say

Reading the lexer tells you the outer boundary of the language, before any grammar is involved.

**No quoted identifiers.** `"my table"` is not a table name here — the double quote is not in `_readSymbol`, so it throws:

```
SELECT * FROM "my table"
  -> Unexpected character '"' at position 14
```

Every real SQL dialect supports delimited identifiers, and this one does not. The consequence is that a column cannot contain a space, cannot start with a digit, and cannot be spelled like a reserved keyword. Chapter 6 shows the partial escape hatch the parser offers.

**No block comments.** `/* ... */` lexes as `SLASH`, `STAR`, and then whatever follows.

**Identifiers are ASCII.** [`_isIdentStart`](../../src/parser/lexer.ts) accepts `a-z`, `A-Z`, and `_` only. A column named `précis` is unreachable.

These are not defects to be ashamed of; they are the cost of 316 lines. But a book that showed the token stream without showing its edges would be teaching you a language that does not exist.

## In the code

| Thing | Where |
|---|---|
| The token type enum | [`TokenType`](../../src/parser/lexer.ts) |
| A token | [`Token`](../../src/parser/lexer.ts) |
| The tokenizer | [`Lexer`](../../src/parser/lexer.ts) |
| Keyword derivation | `KEYWORDS` in [`lexer.ts`](../../src/parser/lexer.ts) |
| String literals | [`_readString`](../../src/parser/lexer.ts) |
| Parameters | [`_readPlaceholder`](../../src/parser/lexer.ts) |
| Operators and maximal munch | [`_readSymbol`](../../src/parser/lexer.ts) |
| Whitespace and comments | [`_skipWhitespaceAndComments`](../../src/parser/lexer.ts) |

## Traps

**`--` beats subtraction.** Covered above. `x--y` is `x` and a comment.

**Keyword tokens are uppercased, identifiers are not.** Comparing `token.value` against a lower-case string works for identifiers and never for keywords.

**Positions are character offsets, not line and column.** Error messages say `at position 38`. On a multi-line query that is harder to act on than it looks, and converting offsets to line and column is left to whoever displays the error.

**A number token has no sign.** `-5` is two tokens. Any code reasoning about literal values must handle the unary minus the parser builds, not expect a negative `NUMBER`.

## Exercises

1. Print the token stream for the running query. Build with `npm run build:ts`, then:

   ```javascript
   const { Lexer } = await import('./dist/parser/lexer.js');
   for (const t of new Lexer(sql).tokens) console.log(t.position, t.type, t.value);
   ```

2. Tokenize `SELECT 'it''s' FROM T` and confirm the string token's value is `it's` — one token, not three.

3. Add a `WINDOW` keyword. How many files do you have to edit for the lexer to recognize it, and why is the answer one?

4. Add support for `/* ... */` block comments to `_skipWhitespaceAndComments`. Decide whether they nest, and write the test that pins your decision down.

5. Add quoted identifiers. Lex `"my column"` into an `IDENT` token whose value is `my column`, and set a flag so later stages know it was quoted. Then find every place in the binder that uppercases an identifier and decide what should happen there. The lexer change is ten lines; the consequences are the interesting part.

## Recap

- The lexer turns a string into a flat array of **tokens**, each carrying a type, a value, and a character **position** that error messages depend on.
- An **`EOF` token** is always appended, so the parser never bounds-checks.
- The **keyword table is derived from the token enum**, so adding a keyword is one edit.
- Keywords are matched case-insensitively and normalized to upper case; **identifiers keep their original spelling**, and case-insensitive resolution happens later in the binder.
- Two-character operators use **maximal munch** — longest match wins at each position.
- The dialect has no quoted identifiers, no block comments, and no exponent notation, and `--` silently swallows the rest of the line.

Next: [chapter 6](06-recursive-descent-parser.md) turns this flat array into a tree.
