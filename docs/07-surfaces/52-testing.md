# 52. Testing a query engine

> After this chapter you will be able to choose a useful reference answer, compare ordered and unordered results correctly, and test an optimization through more than its plan shape.

## The question

A new pass moves a filter to the expected place. Its unit test is green. Can it still return the wrong rows? Yes: a shape test says the transformation happened, but does not establish that it was legal for every join type, null case, or duplicate pattern.

Start with a small answer you can compute independently. The chapter 1 query must return Alice 350 and Carol 300. [first-query.mjs](../examples/first-query.mjs) checks those values rather than learning its expected answer from another invocation of the engine.

## Three complementary checks

| Check | Evidence it provides | What it can miss |
|---|---|---|
| known answer | a specific query agrees with a hand-derived result | untested inputs and query shapes |
| differential comparison | two implementations or configurations agree | a bug shared by both paths |
| plan assertion | the intended optimization or operator was selected | incorrect semantics of that transformation |

Combine them. For predicate pushdown, use a small input containing a customer with no qualifying orders and compare the expected result. Also assert the filter's placement for an applicable inner join. Then compare full query results with and without the pass on a broader corpus.

For spilling, compare an operator under a small and a large memory budget, and include enough data to prove the small-budget run actually spills. Otherwise two identical unspilled paths can pass an apparently useful comparison.

## Compare the result SQL specifies

Without `ORDER BY`, row order is generally unspecified. Compare **bags**: duplicates count. Converting both results into a set would hide an extra or missing duplicate.

With `ORDER BY`, compare the promised order. If the ordering has ties, either accept equivalent permutations within peer groups or add a stable tie-breaker to a test query. `LIMIT` through an unresolved tie can legitimately select different rows, so equality with one arbitrary selection is too strict.

Consider the hand-worked input `[3, 1, 2]` for `ORDER BY x LIMIT 1`. The expected answer is `1`. A false “already sorted” annotation can cause a plan to return `3`. This is why order metadata is a correctness guarantee, unlike a row-count estimate that merely guides a choice.

Handle values deliberately too. Preserve the distinction between `NULL` and a missing field. Account for `bigint` rather than assuming every result can be passed to plain `JSON.stringify`. For floating-point sums, reassociation can change the last few bits; use a justified tolerance when the intended contract permits it, while keeping exact comparisons for exact types and discrete counts.

## Ablation that stays removed

[Chapter 28](../03-optimizer/28-plan-properties-and-ablation.md) showed that collecting statistics can rebuild the optimizer. A test that removes a pass before the first query must ensure that the rebuilt optimizer also omits it. Existing differential tests override `createOptimizer` and check the resulting pass list after compilation.

Ablation is appropriate for optional optimizations. Required lowering steps are different: without subquery unnesting, this engine can execute some uncorrelated dependent joins but rejects remaining correlated ones. The corresponding tests should assert those expected failures rather than demand that every possible reduced pipeline run.

Do not treat the default pipeline as an infallible reference. Keep explicit expected results and independent semantic checks alongside the differential corpus.

## Running the suites

From the repository root:

```bash
npm run check:docs
npm run test:docs
npm run test:unit
npm run test:e2e
```

The book check validates references and structure. Its executable checks run the provided examples. Unit and end-to-end suites cover engine behavior more broadly. [vitest.config.ts](../../vitest.config.ts) includes both `tests/e2e/` and nested `e2e/` directories in the end-to-end project and maps source imports to compiled `dist/` modules. Use the npm scripts so the build is fresh.

When adding an optimizer test, include a query where the rewrite should fire and one where it must refuse. Null-rejecting versus null-accepting predicates, unique versus duplicate keys, and grouped versus ungrouped empty aggregation make useful boundaries. These distinctions challenge the reasoning, not just the implementation's control flow.

## In the code

| Purpose | Source |
|---|---|
| suite selection and resolver | [vitest.config.ts](../../vitest.config.ts) |
| pass ablation corpus | [subquery-unnesting-differential.test.ts](../../tests/e2e/subquery-unnesting-differential.test.ts) |
| join reorder comparisons | [join-reorder-differential.test.ts](../../tests/e2e/join-reorder-differential.test.ts) |
| ordered operator comparison | [merge-join-order-differential.test.ts](../../tests/e2e/merge-join-order-differential.test.ts) |
| encoding comparison | [column-encoding-differential.test.ts](../../tests/e2e/column-encoding-differential.test.ts) |
| runnable semantic examples | [semantics.mjs](../examples/semantics.mjs) |

## Traps

**Agreement is evidence, not proof.** Two paths can share an evaluator, storage decoder, or mistaken assumption.

**A benchmark is not a correctness reference.** Check its rows before interpreting a speedup.

**Removing a pass and corrupting its guard are different experiments.** The first bypasses a transformation; the second can make an otherwise useful transformation unsound.

## Exercises

1. **Understand.** Why does converting `[1, 1, 2]` and `[1, 2]` to sets hide a correctness bug?
2. **Observe.** Run `node docs/examples/semantics.mjs` after building. Explain the two different outer-join results from the input CSVs.
3. **Observe.** Read one differential test and identify its reference, result comparator, and configuration difference.
4. **Extend (optional).** Add a known-answer case with duplicate join keys and a null key. Predict the bag of rows before running it, then verify a relevant optimization variant against that answer.

<details>
<summary>Hints and expected observations</summary>

Sets discard multiplicity. In the outer-join example, `WHERE` removes null-padded rows while `ON` limits matches and preserves customers. A useful new fixture should include both multiple matches and a missing match; otherwise the null and duplicate branches may never execute.

</details>

## Recap

- Known answers, differential comparisons, and plan assertions provide different evidence.
- Preserve duplicates and the ordering SQL actually specifies.
- Verify that an experimental path was reached and a removed pass stayed removed.
- Use tests to challenge rewrite conditions, including conservative refusals.

Next: [chapter 53](53-debugging.md) applies this approach when a real query surprises you.
