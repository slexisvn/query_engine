# 11. The logical plan nodes

> After this chapter you will be able to recognize the main plan node families and use their union type to find the fields a tree walk may access.

## The question

The book's running query produces a plan with eight nodes of seven types:

```
-> Limit (count: 10)
  -> Project (C.C_NAME, SUM(O.O_TOTALPRICE))
    -> Sort (SUM(O.O_TOTALPRICE) DESC)
      -> Aggregate (group by: C.C_NAME) (aggs: SUM(O.O_TOTALPRICE))
        -> Filter (condition: (C.C_MKTSEGMENT = 'BUILDING'))
          -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
            -> Seq Scan on CUSTOMER as C
            -> Seq Scan on ORDERS as O
```

[`PlanNodeType`](../../src/planner/logical-plan.ts) declares twenty-three. So sixteen node types exist that this query never mentions, and no amount of writing SQL will produce some of them. Where do they come from, and who is allowed to create them?

The answer sorts the inventory into three groups, and the sorting is more useful than the list.

## One file, one union

Everything is in [`src/planner/logical-plan.ts`](../../src/planner/logical-plan.ts): the type enum, twenty-three interfaces, the union that joins them, and twenty-three functions that build them. Under 500 lines, and there is no class anywhere in it. A plan node is a plain JavaScript object.

The discriminant is a string enum:

```typescript
export enum PlanNodeType {
  SCAN = 'Scan',
  FILTER = 'Filter',
  PROJECT = 'Project',
  JOIN = 'Join',
  AGGREGATE = 'Aggregate',
  // ...
}
```

Each interface pins `type` to one member, and [`LogicalPlanNode`](../../src/planner/logical-plan.ts) is the union of all twenty-three. That combination gives TypeScript a **discriminated union**: a `switch` on `node.type` narrows the object inside each arm, so `node.condition` is legal under `case PlanNodeType.FILTER` and a compile error anywhere else. Every tree walk in the optimizer, the physical planner, and the formatters is written against that narrowing, and it is why adding a node type produces a list of compiler errors pointing at every place that has to learn about it.

The values are strings rather than numbers so that a plan survives `JSON.stringify` legibly — which matters for the distributed layer, where plan fragments are serialized and shipped to workers.

## The shape every node shares

One non-exported interface supplies the fields common to all of them:

```typescript
interface PlanNodeBase {
  children?: LogicalPlanNode[];
  _cardinality?: number;
  _sortedBy?: SortedByEntry[];
  _cteMap?: Map<string, LogicalPlanNode>;
}
```

Only `children` is structure. The three underscore-prefixed fields are **annotations**: information computed *about* a node rather than part of what it means. `_cardinality` is an estimated row count, `_sortedBy` records an ordering the node's output is known to have, and `_cteMap` carries the bodies of common table expressions. These fields are optional in the type, but their contracts differ. `_cardinality` is a fallible estimate; `_sortedBy` must be a sound ordering guarantee when used to remove work; `_cteMap` supplies plan bodies that a CTE scan needs. Losing or falsifying the latter two can break execution. Chapter 23 covers estimates, and chapter 28 separates estimates from correctness-sensitive metadata.

`children` being optional is not cosmetic. Leaves — `LogicalScanNode`, `LogicalIndexScanNode` — genuinely do not have the field, so every traversal goes through [`getChildren`](../../src/planner/logical-plan.ts), which normalizes the absence to an empty array, and [`setChildren`](../../src/planner/logical-plan.ts), which returns a **copy** with new children rather than mutating:

```typescript
export function setChildren<T extends LogicalPlanNode>(node: T, children: LogicalPlanNode[]): T {
  return { ...node, children } as T;
}
```

That single line is why the optimizer can hold the plan from before a pass and the plan from after it at the same time, which is what the visualizer displays and what the pass-ablation test in chapter 28 depends on.

## The thirteen the planner emits

These are the nodes that come directly from SQL. Every one of them is constructed by [`createLogicalPlan`](../../src/planner/logical-planner.ts), and chapter 12 is about when.

| Node | Key fields | From |
|---|---|---|
| `Scan` | `table`, `alias`, `columns` | a table name in `FROM` |
| `Filter` | `condition` | `WHERE`, `HAVING` |
| `Project` | `expressions`, `outputAlias?` | the select list |
| `Join` | `joinType`, `condition` | `JOIN`, or a comma in `FROM` |
| `Aggregate` | `groupBy`, `aggregates` | `GROUP BY`, or any aggregate call |
| `Sort` | `orderKeys` | `ORDER BY` |
| `Limit` | `count`, `offset` | `LIMIT`, `OFFSET` |
| `Distinct` | — | `SELECT DISTINCT` |
| `SetOp` | `op`, `all` | `UNION`, `INTERSECT`, `EXCEPT` |
| `CTEScan` | `cteName`, `cteId`, `alias` | a reference to a `WITH` name |
| `Window` | `windowExprs` | any `OVER (...)` |
| `DependentJoin` | `subqueryType`, `correlatedColumns`, `compareOp` | a subquery in an expression |
| `SingleRow` | — | a `SELECT` with no `FROM` |

Three of the interfaces, in full, because they are the ones you will read most:

```typescript
export interface LogicalScanNode extends PlanNodeBase {
  type: PlanNodeType.SCAN;
  table: string;
  columns: ColumnInfo[];
  alias: string;
  pruningFilter?: BoundExpr;
}

export interface LogicalJoinNode extends PlanNodeBase {
  type: PlanNodeType.JOIN;
  joinType: JoinType;
  condition: BoundExpr | null;
  markColumn?: string;
  children: LogicalPlanNode[];
}

export interface LogicalAggregateNode extends PlanNodeBase {
  type: PlanNodeType.AGGREGATE;
  groupBy: BoundExpr[];
  aggregates: BoundExpr[];
  children: LogicalPlanNode[];
}
```

Two things generalize from these. First, **every expression field holds a `BoundExpr`**, the fully resolved and typed expression from chapter 9 — never a parser node, never a string. The planner does not re-analyze expressions; it arranges them. Second, **children is a positional array, and position carries meaning.** A join's `children[0]` is its left input and `children[1]` its right, and a `LEFT` join is not symmetric, so swapping them without also changing `joinType` changes the answer.

`SingleRow` deserves a note. `SELECT 1 + 1 AS X` has no table to read, but π needs an input, so the planner supplies a relation of exactly one row with no columns:

```
-> Project ((1 + 1))
  -> SingleRow
```

Closure again. Rather than making `Project` handle a missing child, the planner manufactures the identity element.

## Nine join types

[`JoinType`](../../src/planner/logical-plan.ts) is one of seven enums in the file, and the one with the most surprises in it:

| Member | Meaning | Written by you? |
|---|---|---|
| `INNER` | matching pairs only | yes |
| `LEFT` | plus unmatched left rows, null-padded | yes |
| `RIGHT` | plus unmatched right rows | yes |
| `FULL` | both | yes |
| `CROSS` | every pair, no condition | yes |
| `SEMI` | left rows that have at least one match, once each | no |
| `ANTI` | left rows that have no match | no |
| `MARK` | every left row, plus a boolean column saying whether it matched | no |
| `SINGLE` | like `LEFT`, but errors if the right side yields more than one row | no |

The bottom four have no SQL syntax. They exist because subqueries decompose into them. Write an `EXISTS` and the planner emits a `DependentJoin`:

```
-> Project (C.C_NAME)
  -> Dependent Join (EXISTS)
    -> Seq Scan on CUSTOMER as C
    -> Project (1)
      -> Filter (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
        -> Seq Scan on ORDERS as O
```

and the optimizer turns it into an ordinary join with an unusual type:

```
-> Project (C.C_NAME)
  -> SEMI Join (condition: (O.O_CUSTKEY = C.C_CUSTKEY))
    -> Seq Scan on CUSTOMER as C
    -> Project (O.O_CUSTKEY)
      -> Seq Scan on ORDERS as O
```

That rewrite is chapter 26's subject. What matters here is the division of labor: the planner's job was to record *that there is a correlated subquery*, not to decide how to evaluate one. `DependentJoin` is the node type that says "a subquery lives here"; `SEMI` is what it becomes once something has thought about it.

## The ten that arrive later

The remaining node types are never produced by the planner. Each one is introduced by a specific pass or by the distributed planner, so seeing one in a plan tells you which stage has already run.

| Node | Created by | Chapter |
|---|---|---|
| `TopN` | [`TopNFusion`](../../src/optimizer/passes/topn-fusion.ts), fusing a `Limit` over a `Sort` | 21 |
| `IndexScan` | [`IndexSelection`](../../src/optimizer/passes/index-selection.ts) | 21 |
| `Empty` | [`ExpressionSimplifier`](../../src/optimizer/passes/expression-simplifier.ts) marks it, [`EmptyPropagation`](../../src/optimizer/passes/empty-propagation.ts) moves it up | 16, 19 |
| `Materialize` | [`CTEOptimization`](../../src/optimizer/passes/cte-optimization.ts) | — |
| `PartialAggregate` | [`AggregatePushdown`](../../src/optimizer/passes/aggregate-pushdown.ts) and the distributed layer | 36, 47 |
| `FinalAggregate` | the same two | 36, 47 |
| `Exchange` | [`repartition.ts`](../../src/distributed/optimizer/repartition.ts) and [`partial-aggregate.ts`](../../src/distributed/optimizer/partial-aggregate.ts) | 47 |
| `MergeExchange` | [`src/distributed/optimizer/distributed-sort.ts`](../../src/distributed/optimizer/distributed-sort.ts) | 47 |
| `ExchangeReceive` | [`src/distributed/planner/distributed-planner.ts`](../../src/distributed/planner/distributed-planner.ts) | 47 |
| `CTEAnchor` | nothing, in a running query — see below | — |

Two of the dashes are not oversights. `CTEAnchor` is never constructed at all, for reasons the next section gives. `Materialize` is constructed, by the CTE pass, but no chapter of this book takes it as its subject — the pass that makes it is the least exercised in the pipeline, and saying so is more honest than pointing you at a chapter that does not cover it.

Two nodes are worth watching in real output. `TopN` is what a `Limit` over a `Sort` becomes:

```
-> Project (CUSTOMER.C_NAME)
  -> Top-N (count: 2, offset: 1, order: CUSTOMER.C_NAME ASC)
    -> Seq Scan on CUSTOMER as CUSTOMER
```

And `Empty` marks a subtree the optimizer has proved returns nothing:

```
-> Empty (short-circuit)
  -> Seq Scan on CUSTOMER as CUSTOMER
```

That is `WHERE 1 = 0`. Note that the scan is still there as a child. `Empty` does not delete its subtree, it shadows it — the executor produces no rows and never asks the child for any.

### `CTEAnchor` is dormant

[`LogicalCTEAnchor`](../../src/planner/logical-plan.ts) exists, along with a full interface, a formatter case, a cardinality rule, a cost rule, a rewrite hook, and handling in four optimizer passes and the executor. Nothing under `src/` calls the constructor. The only callers are unit tests.

What runs instead: `planFrom` in [`logical-planner.ts`](../../src/planner/logical-planner.ts) plans a CTE body once, stores it in the planner's `cteMap` under the CTE's name, and emits a childless `CTEScan` at each reference site. The body never appears in the tree:

```
-> Project (B.C_NAME)
  -> CTE Scan (B)
```

The map travels separately, attached to the plan root as `_cteMap` and threaded through the engine by hand. The body of `B` is there, reachable but not printed:

```
-> Project (CUSTOMER.C_CUSTKEY, CUSTOMER.C_NAME, CUSTOMER.C_MKTSEGMENT)
  -> Filter (condition: (CUSTOMER.C_MKTSEGMENT = 'BUILDING'))
    -> Seq Scan on CUSTOMER as CUSTOMER
```

So the engine has two mechanisms for the same job — an in-tree anchor node and an out-of-band map — and only the second one runs. That is worth knowing before you go looking for a `CTE Anchor` line in an `EXPLAIN` and conclude your CTE was optimized away.

## Constructors, and what is really used

Twenty-three functions named `Logical*` build the nodes, and they are the intended entry points:

```typescript
export function LogicalFilter(condition: BoundExpr | null, child: LogicalPlanNode): LogicalFilterNode {
  return { type: PlanNodeType.FILTER, condition, children: [child] };
}
```

They are thin — a literal and a wrapped child — and they exist for defaults and consistency, not encapsulation. `LogicalLimit` normalizes a missing offset to `0`; `LogicalScan` defaults `alias` to the table name; `LogicalUnion` is a one-line wrapper over `LogicalSetOp` for the most common set operation.

Twenty-three constructors and twenty-three node types, and the two sets do not line up. There is no `LogicalEmpty`: every `Empty` node in the engine is an object literal written out at the point of use, seven times across [`empty-propagation.ts`](../../src/optimizer/passes/empty-propagation.ts) and [`expression-simplifier.ts`](../../src/optimizer/passes/expression-simplifier.ts). The count comes out even only because `SetOp` has two constructors, `LogicalUnion` being the second.

The set is also not uniformly exercised. `LogicalUnion` is called from exactly one place in `src/`, the DataFrame's `union` method. [`LogicalTopN`](../../src/planner/logical-plan.ts) is called from nowhere in `src/` at all — `TopNFusion` builds the object literal itself:

```typescript
const topN: LogicalTopNNode = {
  type: PlanNodeType.TOP_N,
  orderKeys: child.orderKeys,
  count: node.count,
  offset: node.offset || 0,
  children: child.children,
};
```

Both styles produce the same object, so nothing is broken; but if you add a field with a default, the constructor is not where every caller will pick it up.

## In the code

| Thing | Where |
|---|---|
| The type enum | [`PlanNodeType`](../../src/planner/logical-plan.ts) |
| The union | [`LogicalPlanNode`](../../src/planner/logical-plan.ts) |
| Join semantics enum | [`JoinType`](../../src/planner/logical-plan.ts) |
| Subquery kinds | [`SubqueryType`](../../src/planner/logical-plan.ts) |
| Set operations | [`SetOpType`](../../src/planner/logical-plan.ts) |
| Distributed transfer kinds | [`ExchangeType`](../../src/planner/logical-plan.ts) |
| Child access | [`getChildren`](../../src/planner/logical-plan.ts), [`setChildren`](../../src/planner/logical-plan.ts) |
| Per-node metadata | [`descriptorOf`](../../src/planner/plan-node-descriptor.ts) |
| Which tables a plan reads | [`collectScannedTables`](../../src/planner/logical-plan.ts) |

## Traps

**`Sort` has `limit` and `offset` fields, and no plan you print will ever show one.** [`LogicalSort`](../../src/planner/logical-plan.ts) takes only order keys, so a sort starts life without them — but [`LimitPushdown`](../../src/optimizer/passes/limit-pushdown.ts) writes them, rewriting a `Limit` over a `Sort` into a `Limit` over an annotated `Sort`. Later in the same pipeline [`TopNFusion`](../../src/optimizer/passes/topn-fusion.ts) replaces that pair with a `TopN` built from the `Limit`, and the annotated `Sort` is discarded. The fields are therefore live for exactly the stretch between those two passes: the cardinality rule reads them there to cap an estimate, and [`selectsRows`](../../src/planner/sort-properties.ts) reads them to stop `SortElimination` from deleting a sort that is now also selecting rows. The read sites further downstream — the distributed repartitioner, [`buildSort`](../../src/execution/builders/pipeline-builders.ts) — only ever see plans that `TopNFusion` has already been through. Chapter 19 meets the same field from the other side.

**`Empty` keeps its child.** The subtree under an `Empty` node is dead but present, so a tree walk that counts scans will count scans that never execute.

**A `CTEScan` has no children.** Any traversal that assumes reachability from the root will miss every CTE body. The bodies live in `_cteMap` on the root, and the engine passes that map alongside the plan everywhere it goes.

**Node objects are shared, not copied, on the way down.** `setChildren` copies the node it is given, but its children are the same objects as before. Two plans from two optimizer passes can therefore share most of their subtrees, which is efficient and means mutating a node in place corrupts both.

**Nine join types, but only five have syntax.** Seeing `SEMI`, `ANTI`, `MARK`, or `SINGLE` in a plan means a subquery was rewritten, not that someone wrote unusual SQL.

## Exercises

### Understand

A plan node says _cardinality=100 and _sortedBy=[K ASC]. Which fact may be an approximation, and which must be sound if a sort is removed?

### Practice

1. **Observe.** Print `Object.keys(PlanNodeType).length` and confirm the count. Then write a query for each of the thirteen planner-emitted types and record the plan. Which two are hardest to trigger?

2. **Observe.** Take the running query's plan and walk it with [`getChildren`](../../src/planner/logical-plan.ts), printing `node.type` at each level. Now do the same for a query with a CTE and explain the discrepancy between what you printed and what the query reads.

3. **Observe.** `EXISTS` gives you a `SEMI` join. Find SQL that yields `ANTI`, and SQL that yields `MARK`. Print both plans before and after optimization.

4. **Extend (optional).** Add a `pruningFilter` to a `LogicalScanNode` by hand and re-print the plan. Does any formatter show it? Find who reads the field, and decide whether the plan printers should.

5. **Extend (optional).** Change [`LogicalTopN`](../../src/planner/logical-plan.ts) to default `offset` to `1` instead of `0` and run the test suite. Predict first which tests can possibly notice, using the `TopNFusion` excerpt above and a search for callers of the constructor — then check whether you were right, and make the change that a query would actually have seen.

### Hints and expected observations

The cardinality may be an estimate. The ordering must hold for every emitted row under the required comparator. CTE bodies are required plan data, not a performance estimate.

## Recap

- One file holds the entire IR: twenty-three interfaces, a **discriminated union** over `PlanNodeType`, and twenty-three constructor functions. Nodes are plain objects; the union plus `switch` narrowing is what keeps tree walks type-safe.
- `PlanNodeBase` supplies `children` plus **metadata**: a row estimate, an ordering guarantee, and CTE bodies. Their contracts differ; metadata used to remove a sort or resolve a CTE is correctness-sensitive.
- **Thirteen** node types come from the planner, one per SQL construct. **Ten** arrive later, each from a named pass or from the distributed planner, so the presence of one tells you which stage has run.
- `JoinType` has **nine** members and only five are writable in SQL; `SEMI`, `ANTI`, `MARK`, and `SINGLE` are what subqueries become.
- `CTEAnchor` is fully specified and **never constructed** outside tests. CTE bodies travel out of band in `_cteMap`, and a `CTEScan` is a childless leaf.
- `setChildren` copies rather than mutates, which is what lets the optimizer keep before-and-after plans side by side.

Next: chapter 12 watches [`createLogicalPlan` build one of these trees](12-building-the-plan.md), clause by clause, and explains why the result is deliberately bad.
