# 5. The lexer

> After this chapter you will be able to read a token stream, explain how keywords are recognized, and distinguish quoted names, strings, numbers, and comments.

## The question

A query arrives as a string. Not a sentence, not a structure — 55 characters:

```
SELECT c.C_NAME FROM CUSTOMER c WHERE c.C_CUSTKEY >= 10
```

Before anything can ask *what does this mean*, something has to answer *where does one word end*. That `>=` is one operator and not a `>` followed by an `=`. That `CUSTOMER` is a name but `FROM` is a keyword. That the `c` before the dot and the `c` after `CUSTOMER` are the same identifier appearing twice.

The lexer establishes those token boundaries. It does not yet resolve names or check types; those jobs come later. Its implementation is in [`src/parser/lexer.ts`](../../src/parser/lexer.ts).

## Tokens

A [`Token`](../../src/parser/lexer.ts) carries four fields (constructor omitted):

```typescript
export class Token {
  type: TokenType;
  value: string;
  position: number;
  quoted: boolean;
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

Fourteen tokens. Whitespace is gone. `>=` is one token, `GTE`. Every token remembers the character offset it started at, which `describePosition` converts to a line and column for an error message.

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

The whole query is tokenized up front into an array, not streamed on demand. This makes lookahead straightforward, as chapter 6 shows. It also stores the complete token sequence in memory; extremely large generated queries make that tradeoff more visible.

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
} else if (ch === QUOTE_DELIMITER) {
  this.tokens.push(this._readQuotedIdent(start));
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

The first character selects a reader; that reader may inspect more characters to finish the token. Six readers handle these cases.

**Strings.** [`_readString`](../../src/parser/lexer.ts) consumes to the closing quote, with SQL's doubling escape: `''` inside a string produces one `'`. There is no backslash escaping — `'it''s'` is the way to write it. An unterminated string throws with its start position.

**Placeholders.** `$1`, `$2` — a dollar sign followed by digits, producing a `PLACEHOLDER` token carrying the number. This is how parameterized queries avoid string interpolation, and the number is resolved against the supplied parameter array much later, in the binder.

**Numbers.** A number starts with a digit and may include a decimal point and an exponent, such as `1.5e-2`. `_readExponent` accepts an exponent only when its optional sign is followed by digits. A leading sign belongs to a separate token: `-5` is `MINUS` followed by `NUMBER`, which the parser combines into unary negation. Write `0.5`, since a leading dot starts a `DOT` token.

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

**Quoted identifiers.** `_readQuotedIdent` reads a double-quoted name such as `"my column"`. It produces `IDENT` with `quoted: true`, preserves the contents, and treats `""` inside the name as one double quote. Empty and unterminated names are errors. The flag lets the parser and binder distinguish a delimited name from an ordinary keyword or identifier.

**Symbols.** [`_readSymbol`](../../src/parser/lexer.ts) is a switch with a small amount of lookahead for the two-character operators. `<` peeks for `=` and `>`, yielding `<=` and `<>`. `>` peeks for `=`. `!` requires a following `=` and throws otherwise, because `!` alone means nothing in this dialect. `|` requires a second `|` to form the concatenation operator.

That is **maximal munch**: at each position, take the longest operator that matches. Without it, `a <= b` would lex as `a < = b` and the parser would report a mysterious error two tokens later.

## Comments, and a sharp edge

[`_skipWhitespaceAndComments`](../../src/parser/lexer.ts) handles whitespace and two comment forms. The line-comment branch is:

```typescript
if (ch === '-' && this.pos + 1 < this.input.length && this.input[this.pos + 1] === '-') {
  while (this.pos < this.input.length && this.input[this.pos] !== '\n') {
    this.pos++;
  }
  continue;
}
```

Two hyphens start a comment that runs to end of line. A separate `_skipBlockComment` reader handles `/* ... */`, including nested block comments with a depth counter. Reaching the end before that counter returns to zero raises an error.

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

## The lexer is only the first boundary

Unquoted identifiers are restricted to ASCII letters, digits, and underscores, with no leading digit. Quoted identifiers can contain spaces, non-ASCII characters, or keyword spellings: `"my table"`, `"précis"`, and `"select"` all become identifier tokens. Resolving one against the catalog still belongs to the binder.

A recognized keyword does not establish that a statement is supported. `VIEW` has a token, for example, but `CREATE VIEW` is not implemented by this parser. Conversely, some function names are ordinary identifiers and need no keyword token. Follow a feature through parsing, binding, and execution before calling it supported. The [dialect reference](../appendix/sql-grammar.md) summarizes these boundaries.

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

**Stored offsets and displayed positions differ.** Tokens store offsets in the JavaScript string. `positionOf` and `describePosition` convert them to one-based line and column values for lexer and parser errors.

**A number token has no sign.** `-5` is two tokens. Any code reasoning about literal values must handle the unary minus the parser builds, not expect a negative `NUMBER`.

## Exercises

### Understand

How do the tokens for 'select', "select", and SELECT differ when the first form is a SQL string and the second a quoted identifier?

### Practice

1. **Observe.** Print the token stream for the running query. Build with `npm run build:ts`, then:

   ```javascript
   const { Lexer } = await import('./dist/parser/lexer.js');
   const { runningQuery: sql } = await import('./docs/examples/fixture.mjs');
   for (const t of new Lexer(sql).tokens) console.log(t.position, t.type, t.value);
   ```

2. **Observe.** Tokenize `SELECT 'it''s' FROM T` and confirm the string token's value is `it's` — one token, not three.

3. **Extend (optional).** Add a `WINDOW` keyword. How many files do you have to edit for the lexer to recognize it, and why is the answer one?

4. **Observe.** Tokenize `SELECT /* outer /* inner */ comment */ 1`, then remove the final `*/`. Confirm that nesting succeeds and an unterminated comment reports its starting location. Trace the depth counter in `_skipBlockComment`.

5. **Observe.** Compare the tokens for `SELECT`, `select`, and `"select"`. Follow the `quoted` flag into the parser and binder. Explain why recognizing a quoted name is separate from resolving that name against a table schema.

### Hints and expected observations

Single quotes produce STRING, double quotes produce IDENT with quoted=true, and unquoted SELECT produces the keyword token. For the block-comment exercise, nested comments must finish at depth zero.

## Recap

- The lexer turns a string into a flat array of **tokens**, each carrying a type, a value, and a character **position** that error messages depend on.
- An **`EOF` token** is always appended, giving the parser an explicit end marker.
- The **keyword table is derived from the token enum**, so adding a keyword is one edit.
- Keywords are matched case-insensitively and normalized to upper case; **identifiers keep their original spelling**, and case-insensitive resolution happens later in the binder.
- Two-character operators use **maximal munch** — longest match wins at each position.
- Quoted identifiers, nested block comments, and exponent notation are supported. `--` consumes the rest of the line, so write a space between subtraction and unary minus.

Next: [chapter 6](06-recursive-descent-parser.md) turns this flat array into a tree.
