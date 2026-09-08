# 8. The binder: scopes and names

> After this chapter you will be able to explain why a select-list alias works in `ORDER BY` and fails in `WHERE`, and how one integer in the binder decides whether a subquery is correlated.

## The question

Two queries, one difference:

```sql
SELECT C_NAME AS NM FROM CUSTOMER WHERE NM = 'Alice'    -- Unknown column: NM
SELECT C_NAME AS NM FROM CUSTOMER ORDER BY NM           -- works
```

Every SQL user learns this as a rule. It is not a rule anyone decided; it is a consequence of the order in which one function binds clauses, and you can point at the line.

## The scope chain

[`BinderScope`](../../src/binder/scope.ts) is an environment: a set of visible relations, and a pointer to an enclosing scope.

```typescript
export class BinderScope {
  parent: BinderScope | null;
  relations: Map<string, ScopeRelation>;
  aliasIndex: Map<string, string>;
  queryBoundary: boolean;
  // ... plus tables, columns, and shadowCount
}
```

Binding a `FROM` clause calls [`addTable`](../../src/binder/scope.ts) for each relation, which records the alias, the column list, and a name-to-position index built once per relation:

```typescript
function indexColumns(columns: ColumnInfo[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < columns.length; i++) {
    const key = columns[i].name.toUpperCase();
    if (!index.has(key)) index.set(key, i);
  }
  return index;
}
```

Every key is uppercased. That single decision is what makes identifier resolution case-insensitive — chapter 5 noted the lexer preserves an identifier's original spelling, and this is where the spelling stops mattering. `c_name`, `C_Name`, and `C_NAME` all hit the same map entry.

Scopes nest two different ways, and the difference is the whole chapter:

```typescript
child(): BinderScope {
  return new BinderScope(this);
}

subqueryChild(): BinderScope {
  return new BinderScope(this, true);
}
```

A plain [`child`](../../src/binder/scope.ts) is a nested lookup environment. A [`subqueryChild`](../../src/binder/scope.ts) is the same thing with `queryBoundary` set — a marker saying *a query starts here*. Nothing else about it differs. What that flag does is counted, not enforced, and the count is what matters.

## Resolving a column

[`resolveColumn`](../../src/binder/scope.ts) takes a name and an optional table alias, and has two modes.

**Qualified** — `c.C_NAME`. Find the scope that owns the alias `c` via [`ownerScopeOf`](../../src/binder/scope.ts), walking up the chain, then look the column up in that relation's index. If the alias is unknown or the relation has no such column, resolution fails.

**Unqualified** — `C_NAME`. Search every relation in the current scope. This is where ambiguity is caught:

```typescript
for (const relation of this.relations.values()) {
  const colIndex = relation.columnIndex.get(upper) ?? -1;
  if (colIndex >= 0) {
    if (found) {
      throw new Error(`Ambiguous column reference: ${name}`);
    }
    found = { ... };
  }
}
```

Note that it does not stop at the first match. It keeps looking specifically so it can detect a second one:

```
SELECT ID FROM N JOIN M ON N.ID = M.ID
  -> Ambiguous column reference: ID
```

Only if nothing was found locally does it ask the parent. Local relations shadow outer ones, which is what you want: a subquery selecting from its own `ORDERS` should see that one, not an outer `ORDERS`.

## Depth is correlation

Here is the part worth slowing down for. When resolution climbs to a parent scope, it counts:

```typescript
if (this.parent) {
  const parentResult = this.parent.resolveColumn(name);
  if (parentResult) {
    return { ...parentResult, depth: parentResult.depth + (this.queryBoundary ? 1 : 0) };
  }
}
```

`depth` is the number of **query boundaries** crossed to find the column. Crossing a plain child scope adds nothing; crossing a subquery boundary adds one.

So `depth === 0` means the column came from this query. `depth > 0` means it came from an enclosing one — which is the definition of a correlated reference. Bind a correlated `EXISTS` and read the depths off the bound tree:

```sql
SELECT C_NAME FROM CUSTOMER c
WHERE EXISTS (SELECT 1 FROM ORDERS o WHERE o.O_CUSTKEY = c.C_CUSTKEY)
```

```
O.O_CUSTKEY  depth=0  correlated=false
C.C_CUSTKEY  depth=1  correlated=true
```

One integer, computed during name lookup, and the entire decorrelation machinery in chapter 27 keys off it. A subquery whose every column reference has `depth === 0` can be evaluated once; one with a correlated reference cannot, and has to be rewritten into a join. **The optimizer never re-derives this** — it is decided here, once, as a side effect of finding out where a name lives.

## The clause order

Now the opening question. [`bindSelect`](../../src/binder/binder.ts) binds clauses in this order, which is neither the written order nor the execution order:

```typescript
if (node.withClause) this.bindWithClause(node.withClause, scope);
const fromScope = scope.child();
if (node.from) plan = this.bindFrom(node.from, fromScope);

const boundSelectItems = this.bindSelectItems(node.selectItems, fromScope);

if (node.where) where = this.bindExpression(node.where, fromScope);

const selectAliasMap = new Map<string, BE.BoundExpr>();
for (const item of boundSelectItems) {
  const alias = item.alias || item.inferredName;
  if (alias) selectAliasMap.set(alias.toUpperCase(), item.expr);
}

if (node.groupBy) groupBy = node.groupBy.map(expr =>
  this.bindPositionalKey('GROUP BY', expr, fromScope, selectAliasMap, boundSelectItems));

if (node.having) having = this.bindExpression(node.having, fromScope);

if (node.orderBy) orderBy = node.orderBy.map(ok => ({
  expr: this.bindPositionalKey('ORDER BY', ok.expr, fromScope, selectAliasMap, boundSelectItems), ... }));
```

Read where `selectAliasMap` is built: **after** `WHERE` is bound, **before** `GROUP BY` and `ORDER BY`. That is the answer.

`WHERE` is bound with `bindExpression` against the scope alone, so `NM` is looked up as a column, is not found, and fails. `GROUP BY` and `ORDER BY` go through [`bindPositionalKey`](../../src/binder/binder.ts), which consults the alias map first. The behavior matches exactly:

| Query | Result |
|---|---|
| `... AS NM ... WHERE NM = 'Alice'` | `Unknown column: NM` |
| `... AS NM ... GROUP BY NM` | works |
| `... AS NM ... ORDER BY NM` | works |

There is a defensible reason for it, beyond implementation convenience. `WHERE` filters rows before aggregation, so allowing it to reference `SUM(x) AS total` would be meaningless — the value does not exist yet. Forbidding aliases wholesale in `WHERE` is a blunt version of that restriction, and it is what the SQL standard specifies.

`bindPositionalKey` also handles ordinals:

```typescript
const ordinal = selectOrdinal(expr);
if (ordinal !== null) {
  if (ordinal < 1 || ordinal > selectItems.length) {
    throw new Error(`${clause} position ${ordinal} is not in select list`);
  }
  return selectItems[ordinal - 1].expr;
}
```

So `ORDER BY 2` resolves to the second select item's already-bound expression — chapter 7's "the literal 2 is not the number two", implemented.

## Expanding the star

[`expandStar`](../../src/binder/binder.ts) asks the scope for its columns and produces one bound reference per column, in relation order then column order:

```typescript
return scope.getAllColumns().map(c => ({
  expr: BE.BoundColumnRef(c.tableAlias, c.column.name, c.columnIndex, c.column.dataType),
  alias: null,
  inferredName: c.column.name,
}));
```

For a two-table join that yields the concatenation, fully typed:

```
SELECT * FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
-> C_CUSTKEY:INT32, C_NAME:VARCHAR, C_MKTSEGMENT:VARCHAR,
   O_ORDERKEY:INT32, O_CUSTKEY:INT32, O_TOTALPRICE:INT32
```

The one node from chapter 7 has become six, with positions and types. `t.*` takes the [`getTableColumns`](../../src/binder/scope.ts) path instead and expands one relation.

## Naming the output

Every result column needs a name, and users only supply some of them. [`bindSelect`](../../src/binder/binder.ts) ends with:

```typescript
outputColumns = boundSelectItems.map((item, i) => ({
  name: item.alias || item.inferredName || `col${i}`,
  expr: item.expr,
  dataType: BE.getExprType(item.expr),
}));
```

An explicit alias wins; otherwise `inferColumnName` guesses from the expression; otherwise a positional fallback. In practice:

```
SELECT I, I + 1, 42, S FROM T     -> I | col1 | col2 | S
SELECT SUM(I), COUNT(*) FROM T    -> sum | count_star
SELECT I AS ALIASED, I FROM T     -> ALIASED | I
```

A bare column keeps its name. An arithmetic expression gets `col1` — named after its *index*, which is why the third item is `col2` and not `col1`. Aggregates get a lower-case function name. Note that nothing enforces uniqueness: two identical expressions produce two columns with the same name.

## Catching illegal queries

The binder is also where a well-formed query can be rejected as meaningless. [`checkGroupingCoverage`](../../src/binder/binder.ts) enforces the grouping rule:

```typescript
BE.walkExpr(expr, node => {
  if (groupKeys.has(exprKey(node))) return false;
  if (node.kind === BE.BoundExprKind.AGGREGATE) return false;
  if (node.kind !== BE.BoundExprKind.COLUMN_REF || node.isCorrelated) return;
  throw new Error(`Column ${name} must appear in the GROUP BY clause or be used in an aggregate function`);
});
```

Walk each select and order-by expression. A subtree that matches a grouping key is fine, and returning `false` prunes the walk there. An aggregate is fine, and also prunes — which is what allows `SUM(x)` where a bare `x` would be rejected. Anything else that is a plain column reference is an error:

```
SELECT C_NAME, COUNT(*) FROM CUSTOMER
  -> Column CUSTOMER.C_NAME must appear in the GROUP BY clause or be used in an aggregate function
```

Correlated references are exempted by the `node.isCorrelated` check — they come from an outer query, where they are already grouped or not grouped by that query's own rules.

Note how aggregates were found in the first place. The binder keeps a `aggregatesFound` map that [`bindAggregateCall`](../../src/binder/binder.ts) writes into as it walks expressions, saved and restored around each nested query:

```typescript
const savedAggregates = this.aggregatesFound;
this.aggregatesFound = new Map();
...
const aggregates = [...this.aggregatesFound.values()];
this.aggregatesFound = savedAggregates;
```

A side channel, because an aggregate can appear anywhere in an expression and the query needs the flat list of them. The save-and-restore is what keeps an inner query's aggregates from leaking into the outer one's.

## Same alias twice

What happens when two relations in nested scopes share an alias? [`addTable`](../../src/binder/scope.ts) detects the collision and mints a distinct internal name:

```typescript
const relationAlias = this.resolveTable(key) ? this.shadowAliasFor(key) : key;
```

[`shadowAliasFor`](../../src/binder/scope.ts) appends a counter from the root scope, producing `CUSTOMER:1`. Lookups by the user-written alias still work — `aliasIndex` maps both names to the same relation — but every bound reference carries the unique one. Downstream, the optimizer compares column references by `alias.name` string, so this uniqueness is a **correctness requirement**, not a nicety. Chapter 17 relies on it.

A plain self-join with distinct aliases needs none of this:

```
SELECT a.C_NAME, b.C_NAME FROM CUSTOMER a JOIN CUSTOMER b ON ...
-> A.C_NAME depth=0, B.C_NAME depth=0
```

`A` and `B` are already distinct. Shadowing only fires when the *same* alias is visible twice.

## In the code

| Thing | Where |
|---|---|
| The environment | [`BinderScope`](../../src/binder/scope.ts) |
| Column lookup and ambiguity | [`resolveColumn`](../../src/binder/scope.ts) |
| Correlation depth | `queryBoundary` in [`resolveColumn`](../../src/binder/scope.ts) |
| Alias collisions | [`shadowAliasFor`](../../src/binder/scope.ts) |
| The binder | [`Binder`](../../src/binder/binder.ts) |
| Clause order | [`bindSelect`](../../src/binder/binder.ts) |
| Aliases and ordinals | [`bindPositionalKey`](../../src/binder/binder.ts) |
| Star expansion | [`expandStar`](../../src/binder/binder.ts) |
| Grouping validation | [`checkGroupingCoverage`](../../src/binder/binder.ts) |

## Traps

**Alias visibility is decided by one line's position.** Moving the `selectAliasMap` construction above the `WHERE` binding would make aliases work in `WHERE` — and silently change the dialect. Whether a change to binding order is a bug fix or a compatibility break is not a question the code can answer for you.

**`depth` is computed at lookup, not by analysis.** Nothing scans for correlation afterwards. If a future refactor resolved names differently, correlation detection would break in a way that shows up as a wrong plan, not a resolution error.

**Output column names are not unique.** `SELECT I, I FROM T` yields two columns named `I`. Anything keying results by name loses one.

**Ambiguity is only checked within a single scope level.** A local match shadows an outer one without complaint — that is intended, but it means adding a column to an outer table can silently change nothing while adding one to an inner table changes meaning.

## Exercises

1. Reproduce the alias table. Bind all three queries and confirm which fail:

   ```javascript
   engine.bind(engine.parseSQL("SELECT C_NAME AS NM FROM CUSTOMER WHERE NM = 'Alice'"));
   ```

2. Bind a correlated `EXISTS` and walk the bound `where` expression printing `tableAlias`, `columnName`, and `depth` for every `BoundColumnRef`. Then nest it two levels deep and predict the depths before running it.

3. Move the `selectAliasMap` construction above the `WHERE` binding in `bindSelect` and rebuild. Which tests fail? Are they testing the behavior deliberately, or incidentally?

4. `checkGroupingCoverage` returns `false` from the walk callback to prune subtrees. Remove one of the two `return false` lines and find the query that now reports a spurious error.

5. Construct a query where `shadowAliasFor` fires. You need the same alias visible in two nested scopes at once. Then print the bound references and find the `:1` suffix.

## Recap

- A [`BinderScope`](../../src/binder/scope.ts) holds visible relations and a parent pointer; all keys are **uppercased**, which is where case-insensitivity is implemented.
- Unqualified lookup searches every local relation and **keeps going after the first hit** to detect ambiguity; local relations shadow outer ones.
- Crossing a scope marked `queryBoundary` increments **`depth`**, and `depth > 0` is the definition of a **correlated** reference. Chapter 27 is built on it.
- `bindSelect` binds `FROM`, then the select list, then `WHERE`, **then** builds the alias map, then `GROUP BY` and `ORDER BY` — which is exactly why aliases work in the latter and not in `WHERE`.
- `*` expands to one typed, positioned reference per column, in relation order, and output names come from an explicit alias, then an inferred name, then `col<index>` — and are **not unique**.
- The binder rejects meaningless-but-well-formed queries, notably via `checkGroupingCoverage`.
- Repeated aliases get **shadow names** like `CUSTOMER:1`, which the optimizer's string-keyed comparisons depend on.

Next: [chapter 9](09-types-and-expressions.md) covers the other half of binding — what type every expression has, and why `5 / 2` is `2.5` here.
