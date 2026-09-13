# 53. Debugging a wrong plan

> After this chapter you will be able to reduce an unexpected query result, find the first stage where its meaning changes, and investigate a slow plan without confusing estimates with actual work.

## The question

“I asked for all customers, so why did Alice and Carol disappear?” Use the book's CSVs and this query:

```sql
SELECT c.C_NAME AS N, o.O_TOTALPRICE AS P
FROM CUSTOMER c LEFT JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE o.O_TOTALPRICE > 500
ORDER BY c.C_NAME
```

It returns only Bob, 900. The plan may show an inner join. Before blaming the optimizer, derive the intended result from the query's semantics.

## Reduce the question to rows

Alice has orders of 100 and 250, Carol has 300, and Bob has 900. The join finds those four order rows. The `WHERE` condition keeps only Bob's row. If a customer had no orders, its null-padded price would also fail the comparison.

To ask for every customer and only orders exceeding 500, put that condition in `ON`:

```sql
SELECT c.C_NAME AS N, o.O_TOTALPRICE AS P
FROM CUSTOMER c LEFT JOIN ORDERS o
  ON c.C_CUSTKEY = o.O_CUSTKEY AND o.O_TOTALPRICE > 500
ORDER BY c.C_NAME
```

Now the result is Alice/NULL, Bob/900, Carol/NULL. Both query results are checked by [semantics.mjs](../examples/semantics.mjs). The first plan's outer-to-inner rewrite is legitimate. The issue was a difference between the requested SQL semantics and the intended question, as chapter 17 explained.

This reduction is useful for engine bugs too. Keep enough rows to preserve the failure: unmatched keys, duplicate keys, nulls, ties, and empty groups often matter more than the original table size.

## Find the first disagreement

When the SQL itself expresses the intended question, inspect stages in order:

1. **Parse:** are precedence and clause boundaries correct? `a + b * 2` should not become `(a + b) * 2`.
2. **Bind:** does each reference point to the intended table, scope, and type? Inspect correlated-reference depth when a subquery is involved.
3. **Logical plan:** are grouping, filtering, ordering, and limits arranged according to the query? A legal plan need not be fast yet.
4. **Optimization:** which first rewrite breaks the expected semantics? Use the observer to narrow the change, then compare results on a tiny fixture.
5. **Physical plan and execution:** does the chosen operator preserve nulls, duplicates, ordering, and types? Compare another operator or a simpler reference where possible.

[inspect-plan.mjs](../examples/inspect-plan.mjs) supplies the inspection scaffold. Some intermediate logical nodes are not executable until lowering finishes, so stopping after each pass and executing blindly is not always possible. In that case inspect the node, complete required lowering, or test the transformation with a focused fixture.

When removing a pass, follow chapter 28's factory override or warm-statistics procedure and check the pass list after compiling. An apparently unchanged result is unhelpful if the pass silently came back.

## When the rows are right but the query is slow

Use `EXPLAIN ANALYZE` to compare estimated and actual rows. Find the earliest substantial discrepancy in the data flow: a filter estimate of 10 rows that actually produces 100,000 can mislead every join and aggregate above it. A large error at the root may be inherited rather than caused there.

Then inspect the selected algorithm and the properties behind it. A nested loop on genuinely tiny inputs can be sensible. A hash build much larger than estimated can spill. A missing ordering guarantee can cause an extra sort; falsely claiming that ordering would be a correctness bug, not a performance fix.

Hold one factor constant at a time. Compare warm runs over identical data. Separate plan selection from execution, and include the cost of initial statistics collection if measuring the user's first-query latency. Cost-model units help explain decisions; they do not predict milliseconds directly.

For memory or distributed failures, keep the relevant configuration in the reproduction. A small fixture may eliminate the spill, scheduling, or network path that caused the original failure. Reduce until the behavior is understandable, not until it disappears.

## A useful reproduction

Save a runnable script containing the schema, input rows or deterministic generator, exact query, expected answer, and actual answer. Record the commit, Node version, and relevant `QE_` settings. Include raw and optimized plans when a rewrite is implicated, or a physical profile when the issue is performance.

Finish the fix with a test that fails for the demonstrated reason. For a missing duplicate, assert the bag multiplicity; for a bad sort, assert order; for a falsely pruned chunk, include a matching row inside that chunk. A plan snapshot can accompany this, but it should not replace the semantic assertion.

## In the code

| Investigation | Source |
|---|---|
| exposed compilation stages | [`QueryEngine`](../../src/engine/query-engine.ts) |
| observer and pass management | [`Optimizer`](../../src/optimizer/optimizer.ts) |
| null-rejection checks | [null-rejection.ts](../../src/optimizer/passes/null-rejection.ts) |
| estimate and row profiles | [execution-profile.ts](../../src/execution/execution-profile.ts) |
| minimal semantic examples | [semantics.mjs](../examples/semantics.mjs) |

## Traps

**Changing the SQL can change the question.** `ON` and `WHERE` are not interchangeable across an outer join.

**An estimate is allowed to be wrong; a legality condition is not.** Diagnose those categories separately.

**Reduction can remove the trigger.** Preserve the key distribution, null case, spill threshold, or worker topology responsible for the failure.

## Exercises

1. **Understand.** Add a fourth customer with no orders. Predict both opening queries' answers.
2. **Observe.** Run the semantic example and inspect both optimized plans. Explain their join types without referring to performance.
3. **Observe.** Use `EXPLAIN ANALYZE` on a query with a selective filter. Locate the first estimate/actual discrepancy, even if it is small.
4. **Extend (optional).** Turn a surprising query into a script with fewer than ten input rows, or explain which size-dependent trigger prevents that reduction. Add an expected-result assertion.

<details>
<summary>Hints and expected observations</summary>

The fourth customer is absent from the `WHERE` version and present with a null price in the `ON` version. Both placements are valid SQL with different meanings. For a slow query, inspect the filter and scan before attributing a downstream estimate error to the join.

</details>

## Recap

- Derive a small expected result before diagnosing the plan.
- Trace the first stage where meaning or an estimate diverges.
- Verify the altered optimizer actually ran.
- Keep the failure trigger and make the final test assert its observable consequence.

Next: [chapter 54](54-wasm.md) applies the same evidence-driven method to acceleration that may be loaded but unused.
