# 50. The DataFrame API

> After this chapter you will be able to build the running query with method calls, identify which calls only construct a plan, and inspect the SQL and DataFrame routes to execution.

## The question

Do you need a second optimizer to support a DataFrame API? This engine does not. A DataFrame stores a logical plan and a schema. Calls such as `filter` and `select` return a new DataFrame whose plan wraps the previous one. Execution can then use the same optimizer and operators as SQL.

Run the complete example from the repository root:

```bash
npm run build:ts
node docs/examples/dataframe.mjs
```

It uses the chapter 1 CSVs and checks the same result: Alice 350, Carol 300.

## Build a plan without running it

The example starts with two frames. This excerpt assumes the engine has loaded the book's tables; [dataframe.mjs](../examples/dataframe.mjs) includes setup and cleanup.

```javascript
const customers = engine.table('CUSTOMER')
  .filter(col('C_MKTSEGMENT').eq('BUILDING'))
  .select(col('C_CUSTKEY').alias('customer_key'), 'C_NAME');

const orders = engine.table('ORDERS')
  .select(col('O_CUSTKEY').alias('customer_key'), 'O_TOTALPRICE');

const query = customers.join(orders, 'customer_key')
  .groupBy('C_NAME')
  .agg(sum('O_TOTALPRICE').alias('TOTAL'))
  .orderBy(col('TOTAL').desc())
  .limit(10);
```

Read the intermediate schemas before the rows. The customer frame exposes `customer_key` and `C_NAME`; the orders frame exposes `customer_key` and `O_TOTALPRICE`. The named-key `join` requires its key to exist on both sides, which is why the source columns were renamed. After grouping, the schema is `C_NAME, TOTAL`.

The construction calls resolve expressions and build nodes, but do not scan the tables. The customer filter would retain two rows; the join would produce three; the aggregate would produce two. Those are predictions until an action executes the plan.

## Expressions are values too

[`col`](../../src/dataframe/column-expr.ts) describes a column reference; [`lit`](../../src/dataframe/column-expr.ts) describes a literal; [`expr`](../../src/dataframe/column-expr.ts) accepts a SQL expression. The fluent expression `col('A').gt(5)` constructs a comparison rather than comparing a JavaScript object immediately.

String arguments have context-specific meanings. `select('C_NAME')` names a column, while `filter("C_MKTSEGMENT = 'BUILDING'")` parses a predicate. Use `expr('A * 2')` when a selection should compute an expression. The parser and binder are therefore still involved in SQL-expression shortcuts, even though direct `Col` expressions can construct bound nodes without a full SQL statement.

`withColumn` replaces a named column or adds one through projection. It returns a derived frame; it does not update the stored table. Likewise, `drop` changes the frame's output schema, not the catalog table.

## The execution boundary

| Call | Effect |
|---|---|
| `query.explain()` | prints the frame's current logical plan without optimizing or executing it |
| `await query.collect()` | optimizes and executes, then materializes result rows |
| `await query.count()` | executes a count over the frame |
| `for await (const chunk of query.chunks())` | executes and consumes result batches |
| `await query.show(10)` | executes a limited result and returns a formatted string |

`collect` delegates through [`_runPlan`](../../src/engine/query-engine.ts), which ensures statistics, optimizes, prepares CTE definitions, and executes. Repeated actions are repeated queries; the DataFrame itself is not a cached result. A frame shares its engine and catalog, so keep the engine available until its actions finish.

`frame.sql('SELECT ... FROM self')` provides a SQL bridge: the frame's plan is exposed as `self`. That is useful for constructs the fluent API does not express directly. The SQL route and direct method calls can begin with different logical shapes while producing equivalent results.

## In the code

| Purpose | Source |
|---|---|
| plan and schema wrapper | [`DataFrame`](../../src/dataframe/dataframe.ts) |
| grouped aggregation builder | [`GroupedData`](../../src/dataframe/dataframe.ts) |
| fluent expressions | [`Col`](../../src/dataframe/column-expr.ts) |
| field resolution | [`DFSchema`](../../src/dataframe/schema.ts) |
| execution boundary | [`_runPlan`](../../src/engine/query-engine.ts) |
| complete worked example | [dataframe.mjs](../examples/dataframe.mjs) |

## Traps

**DataFrame `explain` and SQL `EXPLAIN` inspect different stages.** The former prints the stored logical plan; the latter uses compilation and includes a physical plan. Different printed trees do not by themselves imply different answers.

**A shared key name is an API requirement here.** Renaming keys before `join` makes it explicit. More general SQL join predicates remain available through SQL.

**A row object needs usable output names.** Alias computed expressions deliberately, especially when several expressions would otherwise share a name.

## Exercises

1. **Understand.** Write the schema after each of the two `select` calls and after `agg`. Which step removes the individual order prices?
2. **Observe.** Run the script, then compare its result with `book:query`. Compare plans separately from results.
3. **Observe.** Replace the fluent filter with the SQL-string filter shown above. Confirm the rows still match.
4. **Extend (optional).** Add a derived expression with `withColumn`, collect the derived frame, and then query the original table. Verify that the stored schema did not change.

<details>
<summary>Hints and expected observations</summary>

The join needs two columns named `customer_key`. Aggregation replaces the individual prices with `TOTAL`. Both entry points produce Alice 350 and Carol 300, but the DataFrame route has explicit rename projections. `withColumn` constructs a new projection; it does not alter table storage.

</details>

## Recap

- A DataFrame carries a logical plan and schema; transformations build another frame.
- Direct expressions and SQL-expression shortcuts meet at bound expressions and logical nodes.
- Actions execute through the shared optimizer and executor.
- Compare results and plan stages deliberately: the two `explain` surfaces do different work.

Next: [chapter 51](51-tools.md) uses these inspection surfaces to answer concrete debugging questions.
