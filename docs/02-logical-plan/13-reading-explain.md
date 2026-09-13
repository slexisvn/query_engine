# 13. Reading EXPLAIN

> After this chapter you will be able to read either of the two plan printers this engine ships, say which one you are looking at, and name the things neither of them tells you.

## The question

Ask the engine for the plan of the book's running query two different ways and you get two different answers.

Through the REPL's meta command:

```
Project
  TopN(10)
    Aggregate
      Join(INNER)
        Filter
          Scan(CUSTOMER AS C)
        Scan(ORDERS AS O)
```

Through SQL:

```
-> Project (C.C_NAME, SUM(O.O_TOTALPRICE))
  -> Top-N (count: 10, order: SUM(O.O_TOTALPRICE) DESC)
    -> Aggregate (group by: C.C_NAME) (aggs: SUM(O.O_TOTALPRICE))
      -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
        -> Filter (condition: (C.C_MKTSEGMENT = 'BUILDING'))
          -> Seq Scan on CUSTOMER as C
        -> Seq Scan on ORDERS as O

Physical Plan:
Project
  TopN
    PerfectHashAggregate
      NestedLoopJoin(INNER, build=left)
        Filter
          TableScan
        TableScan
```

Same plan. Same seven nodes in the same seven positions. Two entirely different renderings, produced by two functions in two files that do not know about each other. This chapter is about both of them, about the split of detail between them, and about the questions neither can answer.

## `formatPlan`, the verbose printer

[`formatPlan`](../../src/planner/plan-formatter.ts) is nine lines and does one thing: pre-order depth-first traversal, two spaces of indent per level, an arrow before every node.

```typescript
export function formatPlan(plan: LogicalPlanNode, depth: number = 0): string {
  const indent = '  '.repeat(depth);
  let result = `${indent}-> ${formatNode(plan)}\n`;

  if (plan.children && plan.children.length > 0) {
    for (const child of plan.children) {
      result += formatPlan(child, depth + 1);
    }
  }

  return result;
}
```

The `->` is decoration, not information — every line has one. What carries meaning is the indent, which is the only thing telling you that a node is a child rather than a sibling. Two nodes at the same indentation under a `Join` are its left and right inputs, **in that order**, and since a `LEFT Join` is not symmetric the order is load-bearing.

All the per-node detail lives in [`formatNode`](../../src/planner/plan-formatter.ts), one `switch` with seventeen explicit cases:

| Node | Rendered as |
|---|---|
| `Scan` | `Seq Scan on CUSTOMER as C` |
| `IndexScan` | `Index Scan using IDX_CUSTOMER_C_CUSTKEY on CUSTOMER (key: 42)` |
| `Filter` | `Filter (condition: (C.C_MKTSEGMENT = 'BUILDING'))` |
| `Project` | `Project (C.C_NAME, SUM(O.O_TOTALPRICE))` |
| `Join` | `LEFT Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))` |
| `Aggregate` | `Aggregate (group by: C.C_NAME) (aggs: SUM(O.O_TOTALPRICE))` |
| `Sort` | `Sort (SUM(O.O_TOTALPRICE) DESC)` |
| `Limit` | `Limit (count: 2, offset: 1)` |
| `TopN` | `Top-N (count: 2, offset: 1, order: CUSTOMER.C_NAME ASC)` |
| `Distinct` | `Distinct` |
| `SetOp` | `Union`, `Union All`, `Intersect`, `Except` |
| `CTEScan` | `CTE Scan (B)` |
| `CTEAnchor` | `CTE Anchor (B)` |
| `Materialize` | `Materialize` |
| `DependentJoin` | `Dependent Join (EXISTS)` |
| `Empty` | `Empty (short-circuit)` |
| `Window` | `Window (ROW_NUMBER)` |

`CTE Anchor` and `Materialize` are in that list for completeness rather than for use. The anchor node is never constructed at all — [chapter 11](11-the-logical-plan-nodes.md) has the story — and `Materialize` appears only when the CTE pass builds one.

Two spellings are worth memorizing because they are easy to misread. An `INNER` join prints with **no** type prefix — the `joinType` is omitted when it is `INNER`, so a bare `Join` is an inner join and anything else announces itself. And `offset` is printed only when it is non-zero, so `Limit (count: 10)` means offset zero rather than offset unknown.

The remaining six node types have no case and fall through to `default`, which prints the bare enum value:

```
-> Project ((1 + 1))
  -> SingleRow
```

`SingleRow`, `Exchange`, `PartialAggregate`, `FinalAggregate`, `MergeExchange`, and `ExchangeReceive` all print as their type name and nothing else. Five of those six are the distributed-execution nodes from chapter 47 — which, as the next section shows, is not a coincidence.

## `formatExpression` and its blind spot

Everything inside the parentheses comes from [`formatExpression`](../../src/planner/plan-formatter.ts), which reconstructs SQL-ish text from a bound expression. It is fully parenthesized, so nesting is unambiguous and nothing depends on you remembering operator precedence:

```
-> Project (CUSTOMER.C_NAME)
  -> Filter (condition: ((CUSTOMER.C_CUSTKEY >= 2) AND (CUSTOMER.C_CUSTKEY <= 3)))
    -> Seq Scan on CUSTOMER as CUSTOMER
```

Date literals get special treatment, because a `DATE` is stored as a count of days since the epoch (chapter 4) and printing the integer would be useless:

```
-> Project (ORDERS.O_ORDERKEY)
  -> Filter (condition: (ORDERS.O_ORDERDATE > DATE '1996-02-01'))
    -> Seq Scan on ORDERS as ORDERS
```

[`epochDaysToDate`](../../src/storage/data-type.ts) converts it back for display only. Nothing in the plan holds a formatted date.

Now the limitation. `formatExpression` handles seven of the eighteen members of `BoundExprKind`: column references, literals, binary and unary operators, function calls, aggregates, and `IS NULL`. The other eleven fall to a default arm that prints the kind name in angle brackets:

```typescript
default:
  return expr.kind ? `<${expr.kind}>` : JSON.stringify(expr);
```

So these lines, each lifted from the plan of a query that differs only in its predicate, are all real current output:

```
  -> Filter (condition: <BoundLike>)
  -> Filter (condition: <BoundCase>)
  -> Filter (condition: <BoundBetween>)
  -> Filter (condition: <BoundInList>)
-> Project (CUSTOMER.C_NAME, <BoundWindow>)
```

A `LIKE`, a `CASE`, a `BETWEEN`, an `IN (...)` list, a `CAST`, an `EXTRACT`, an interval, a window function, a subquery, an `EXISTS`, or a quantified comparison is invisible in the plan. You can see *that* there is a filter and *where* it sits; you cannot see what it tests. This is the single biggest gap in the engine's explain output, and it is worth knowing before you spend twenty minutes wondering which of your three `CASE` expressions the optimizer moved. Chapter 51's visualizer is the workaround, and exercise 3 is the fix.

## `planToString`, the compact printer

The other printer lives in [`logical-plan.ts`](../../src/planner/logical-plan.ts) rather than in the formatter file, and it is deliberately terse: node type, sometimes one parenthesized fact, no arrow.

```typescript
export function planToString(node: LogicalPlanNode, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  let str = `${prefix}${node.type}`;

  switch (node.type) {
    case PlanNodeType.SCAN:
      str += `(${node.table}${node.alias !== node.table ? ` AS ${node.alias}` : ''})`;
      break;
    case PlanNodeType.JOIN:
      str += `(${node.joinType})`;
      break;
    // ...
```

Its `switch` has fifteen cases, and here is the interesting part: **the two printers annotate almost complementary sets of node types.**

| Node | `formatPlan` | `planToString` |
|---|---|---|
| `Filter` | shows the condition | bare `Filter` |
| `Project` | shows the expressions | bare `Project` |
| `Aggregate` | shows keys and aggregates | bare `Aggregate` |
| `Sort` | shows the keys | bare `Sort` |
| `Join` | condition; `INNER` implied | `Join(INNER)`, always explicit |
| `Exchange` | bare `Exchange` | `Exchange(hash_shuffle)` |
| `PartialAggregate` | bare `PartialAggregate` | `PartialAggregate(partial)` |
| `MergeExchange` | bare `MergeExchange` | `MergeExchange(all)`, or `MergeExchange(limit=10)` |
| `ExchangeReceive` | bare `ExchangeReceive` | `ExchangeReceive(fragments=[1,2])` |

`formatPlan` knows about expressions and knows nothing about distribution. `planToString` knows about distribution and drops every expression. Neither is a subset of the other, and on a distributed plan you need both. Here is a grouped, ordered query planned for a cluster:

```
[formatPlan]                                      [planToString]
-> Project (CUSTOMER.C_MKTSEGMENT, COUNT_STAR())  Project
  -> MergeExchange                                  MergeExchange(all)
    -> Sort (CUSTOMER.C_MKTSEGMENT ASC)               Sort
      -> FinalAggregate                                 FinalAggregate(final)
        -> Exchange                                       Exchange(hash_shuffle)
          -> PartialAggregate                               PartialAggregate(partial)
            -> Seq Scan on CUSTOMER as CUSTOMER               Scan(CUSTOMER)
```

The detail alternates as you read down. The left column is the only place that tells you what the `Sort` sorts by; the right is the only place that tells you the `Exchange` is a hash shuffle and the `MergeExchange` is unlimited.

Compare them on the same optimized plan:

```
[formatPlan]                                               [planToString]
-> Project (C.C_NAME)                                      Project
  -> SEMI Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))      Join(SEMI)
    -> Seq Scan on CUSTOMER as C                               Scan(CUSTOMER AS C)
    -> Project (O.O_CUSTKEY)                                   Project
      -> Seq Scan on ORDERS as O                                 Scan(ORDERS AS O)
```

The alias is printed only when it differs from the table name, so an unaliased table prints as `Scan(CUSTOMER)`.

## Why there are two

Because they answer different questions, and the third caller settles which is which.

**`.explain` in the REPL** uses `planToString`. It is the *shape* view: you are at a prompt, iterating, and you want to know whether the filter ended up below the join. A line-wrapping list of projection expressions would bury that.

```typescript
const { planToString } = await import('../planner/logical-plan.js');
console.log('');
console.log(planToString(plan));
```

**`EXPLAIN` as SQL** goes through [`_formatPlan`](../../src/engine/query-engine.ts), which uses `formatPlan`. It is the *detail* view: a result row you will read carefully, paste into a bug report, and compare against another one.

**`DataFrame.explain()`** also uses `planToString`, for the same reason the REPL does — it returns a string you print while building a query interactively.

There is one behavioral difference between them that has nothing to do with formatting, and it will confuse you at least once. `.explain` and SQL `EXPLAIN` both go through [`compile`](../../src/engine/query-engine.ts), which runs the optimizer, so both show the **optimized** plan. [`DataFrame.explain()`](../../src/dataframe/dataframe.ts) prints `this._plan`, which for a frame built by `engine.sql(...)` has not been optimized yet:

```
Limit(10)
  Project
    Sort
      Aggregate
        Filter
          Join(INNER)
            Scan(CUSTOMER AS C)
            Scan(ORDERS AS O)
```

`Limit` over `Sort`, filter above the join — that is the raw planner output from chapter 12, not a worse optimizer decision.

## What `EXPLAIN` adds

The SQL form appends a second tree. [`_formatPlan`](../../src/engine/query-engine.ts) runs the physical planner and concatenates:

```typescript
async _formatPlan(plan: LogicalPlanNode): Promise<string> {
  const { physicalPlanToString } = await import('../execution/physical-plan.js');
  const physical = this.executor.resources.physicalPlanner.plan(plan);
  return `${await this._formatLogicalPlan(plan)}
Physical Plan:
${physicalPlanToString(physical)}`;
}
```

That is where the algorithm choices show up — `PerfectHashAggregate`, `NestedLoopJoin(INNER, build=left)` — and it is the only place they are visible, because the logical plan by construction does not have them. Chapter 29 is about how those choices are made.

`EXPLAIN ANALYZE` runs the query and annotates the physical tree with what actually happened:

```
-> Project (CUSTOMER.C_NAME)
  -> Filter (condition: (CUSTOMER.C_MKTSEGMENT = 'BUILDING'))
    -> Seq Scan on CUSTOMER as CUSTOMER

Physical Plan:
Project est=2 actual=2 (on target)
  Filter est=2 actual=2 (on target)
    TableScan est=3 actual=3 (on target)
Execution Time: 4.92 ms
Rows Returned: 2
```

`est` versus `actual` is the most useful debugging number the engine produces. A plan that is slow for no visible reason is usually a plan where one node's estimate is wrong by a factor of a thousand, and every decision above it was made on that number. Chapter 53 uses this column as its first diagnostic.

Both forms come back as a single result row — the column is `EXPLAIN_PLAN`, or `EXPLAIN_ANALYZE` for the analyze form — so the plan arrives as data, not as console output. Note also that [`compile`](../../src/engine/query-engine.ts) declines to cache a plan when `isExplain` is set, so an `EXPLAIN` never populates the plan cache for the query it explains.

## What neither printer shows

Four things, and each one has caught somebody.

**The annotations.** `_cardinality` and `_sortedBy` from chapter 11 are on the nodes and are read by the cost model, but neither printer touches them. Row-count estimates appear only under `EXPLAIN ANALYZE`, and only on the physical tree.

**CTE bodies.** A `CTEScan` is a childless leaf, so a `WITH` clause of any size prints as two lines:

```
-> Project (B.C_NAME)
  -> CTE Scan (B)
```

The body is in `_cteMap` on the plan root, and no printer walks it. If your CTE is the slow part of the query, `EXPLAIN` will not show you why.

**`Empty` still prints its dead subtree.** The child under an `Empty` node never executes, but it is printed exactly like a live one:

```
-> Empty (short-circuit)
  -> Seq Scan on CUSTOMER as CUSTOMER
```

**Anything `formatExpression` cannot render.** See `<BoundLike>` above.

The general shape of all four: the printers are honest about **structure** and lossy about **content**. Structure is what you usually want, which is why they have survived in this form — but knowing exactly what has been dropped is the difference between reading a plan and guessing at one.

## In the code

| Thing | Where |
|---|---|
| Verbose tree | [`formatPlan`](../../src/planner/plan-formatter.ts) |
| Per-node detail | [`formatNode`](../../src/planner/plan-formatter.ts) |
| Expression rendering | [`formatExpression`](../../src/planner/plan-formatter.ts) |
| Compact tree | [`planToString`](../../src/planner/logical-plan.ts) |
| SQL `EXPLAIN` assembly | [`_formatPlan`](../../src/engine/query-engine.ts) |
| `EXPLAIN` result row | [`_explainPlanResult`](../../src/engine/query-engine.ts) |
| REPL meta command | [`src/cli/repl.ts`](../../src/cli/repl.ts) |
| DataFrame form | [`explain`](../../src/dataframe/dataframe.ts) |
| Physical tree | [`physicalPlanToString`](../../src/execution/physical-plan.ts) |
| Timing and counts | [`profileToString`](../../src/execution/execution-profile.ts) |
| Date rendering | [`epochDaysToDate`](../../src/storage/data-type.ts) |

## Traps

**A bare `Join` is an `INNER` join in `formatPlan` and never appears in `planToString`.** The verbose printer omits `INNER`; the compact printer always writes the type. Seeing `Join` in one and `Join(INNER)` in the other is not a difference in the plan.

**`.explain` runs on the line you type it; `EXPLAIN` waits for a semicolon.** Any line starting with `.` is dispatched immediately, and the REPL appends the terminator itself. A SQL statement is buffered and re-prompted with `...>` until you end it with `;`, so an `EXPLAIN` that appears to do nothing is usually an `EXPLAIN` still waiting for one.

**`DataFrame.explain()` shows the unoptimized plan.** The other two show the optimized one. If a DataFrame plan looks naive, that is why.

**Neither printer marks which input of a join is which.** Left is the first child printed and right is the second; nothing labels them. The physical tree does say `build=left`, which is a different question with a confusingly similar answer: a join algorithm reads one input into memory first — the **build side** — and then streams the other past it, and `build=left` says which one that was. Which input is *left* is a fact about the query; which input *builds* is a decision the physical planner made about the data. [Chapter 34](../04-execution/34-hash-join.md) is where the second one starts to matter.

**The REPL re-optimizes when connected to a cluster.** With a coordinator attached, `.explain` runs `engine.optimize(markDistributed(plan))` before printing, so the tree you see has exchange nodes the single-node path would never produce.

## Exercises

### Understand

A physical plan contains HashJoin above two scans. What does that establish, and what must EXPLAIN ANALYZE or instrumentation add?

### Practice

1. **Observe.** Print the same plan through both printers in one script, side by side. Then find a query where the compact printer is genuinely more useful, and one where it is genuinely worse.

2. **Observe.** Run `EXPLAIN` and `EXPLAIN ANALYZE` on a query over a few thousand rows and find a node whose `est` is off by more than 10x. Which of the two trees does the estimate appear on, and why is it not on the other?

3. **Extend (optional).** Teach [`formatExpression`](../../src/planner/plan-formatter.ts) to render `BoundExprKind.LIKE` and `BoundExprKind.BETWEEN`. Confirm that `Filter (condition: <BoundLike>)` becomes something readable, then run `npm run test:unit` and see whether any test pinned the old output.

4. **Extend (optional).** Make `EXPLAIN` print CTE bodies. The map is on `plan._cteMap`; the hard part is deciding where in the output they go and how to make it clear they are not children of the `CTEScan`. Write down your design before you write code.

5. **Extend (optional).** Add estimated cardinality to `formatNode` as a suffix such as `(rows=1500)`. Run it on the running query and decide whether the extra column helps or clutters — then argue for keeping or reverting it.

### Hints and expected observations

It identifies the chosen algorithm and inputs. It does not establish actual row counts, elapsed time, spilling, or the worker path that ran.

## Recap

- The engine has **two** logical-plan printers. [`formatPlan`](../../src/planner/plan-formatter.ts) is verbose, arrow-prefixed, and used by SQL `EXPLAIN`. [`planToString`](../../src/planner/logical-plan.ts) is compact, node names only, and used by the REPL's `.explain` and by `DataFrame.explain()`.
- They annotate nearly **complementary** sets of node types: the verbose printer shows expressions and ignores the distributed nodes; the compact printer shows distribution and drops every expression.
- [`formatExpression`](../../src/planner/plan-formatter.ts) renders **seven of eighteen** expression kinds; the rest print as `<BoundLike>`, `<BoundCase>`, and so on. Predicates using `LIKE`, `CASE`, `BETWEEN`, `IN`, or `CAST` are structurally visible but unreadable.
- SQL `EXPLAIN` appends the **physical plan**, which is the only place algorithm choices appear; `EXPLAIN ANALYZE` adds `est` versus `actual` row counts and a timing line.
- Both `EXPLAIN` forms and the REPL's `.explain` show the **optimized** plan; `DataFrame.explain()` shows the raw planner output.
- Neither printer shows **cardinality annotations, CTE bodies, or the difference between a live and a dead subtree** under `Empty`. They are precise about structure and lossy about content.

That completes Part 2. The query is now a tree of relational operators — correct, complete, and slow, and you can read every line the engine prints about it. Next: Part 3 opens with chapter 14, "Why optimize at all", and then spends fifteen chapters answering it.
