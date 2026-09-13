# 29. From logical to physical

> After this chapter you will be able to distinguish fixed physical mappings from costed alternatives and find the estimates behind a choice.

## The question

The book's running query joins customers to orders. Chapter 34 explains hash join at length, and chapter 1 said the fix for the naive nested loop is "build a hash table". So the running query gets a hash join.

It does not. On the three customers and four orders from chapter 1:

```
Physical Plan:
Project
  TopN
    PerfectHashAggregate
      NestedLoopJoin(INNER, build=left)
        Filter
          TableScan
        TableScan
```

Scale the same tables to 30,000 customers and 120,000 orders — same SQL, character for character, and the same logical plan — and you get a different program:

```
Physical Plan:
Project
  TopN
    HashAggregate
      HashJoin(INNER, build=left, runtimeFilter)
        Filter
          TableScan
        TableScan
```

Two of the six operators changed. Nothing about the query changed. The stage that made that decision is [`PhysicalPlanner`](../../src/execution/physical-planner.ts), and it is the last thing that happens before any data moves.

## Two kinds of node

The optimizer's output is a **logical plan**: a tree of relational operations that says *what* to compute. A **physical plan** says *how*. [`PhysicalPlanNode`](../../src/execution/physical-plan.ts) is the second tree, and it carries three things the logical node did not have — a concrete operator type, an estimated cardinality, and a cost.

Most of the translation is a lookup. [`planNode`](../../src/execution/physical-planner.ts) is the whole dispatcher:

```typescript
planNode(node: LogicalPlanNode, required: RequiredOrder = null): PhysicalPlanNode {
  const childRequired = requiredOrderFor(node, required);
  const children = (node.children ?? []).map((child) => this.planNode(child, childRequired));
  const physicalType = descriptorOf(node.type).physicalType;

  if (physicalType === null) return this.planCostBased(node, children, required);

  const satisfied = this.planSatisfiedOrder(node, children);
  if (satisfied) return satisfied;

  return physicalOperator(physicalType, node, children, cardinalityOf(node), this.operatorCost(node, children));
}
```

Children first, then the node. [`descriptorOf`](../../src/planner/plan-node-descriptor.ts) returns a row from a table keyed by logical node type, and its `physicalType` field is the answer for almost everything: `Filter` becomes `Filter`, `Sort` becomes `Sort`, `Scan` becomes `TableScan`. One logical node, one operator, no thinking.

**Exactly two entries in that table have `physicalType: null`** — `AGGREGATE` and `JOIN`. Those are the two decisions worth making, and they are the two operators that changed when the tables got bigger.

The same descriptor row also carries a `cost` function, so the cost rule for every non-join, non-aggregate operator lives beside its operator type rather than in a switch statement somewhere else.

## Where the numbers come from

Costing needs row counts, and the logical plan does not carry them by default. [`plan`](../../src/execution/physical-planner.ts) annotates first:

```typescript
plan(node: LogicalPlanNode): PhysicalPlanNode {
  return this.planNode(this.planProperties.annotate(node), null);
}
```

[`PlanPropertyAnnotator`](../../src/planner/plan-properties.ts) walks the tree bottom-up and writes two fields onto every node: `_cardinality`, from the statistics-driven estimator of chapter 23, and `_sortedBy`, from [`inferSortOrder`](../../src/planner/sort-properties.ts). Every cost in the physical plan is computed from those estimates. **A physical plan is only as good as the cardinality estimates it was built from**, and chapter 24 covers how badly those can go wrong.

You can see the gap directly. `EXPLAIN ANALYZE` runs the query and prints the estimate beside what actually happened:

```
Physical Plan:
Project est=10 actual=10 (on target)
  TopN est=10 actual=10 (on target)
    HashAggregate est=27722 actual=6000 (4.6x over)
      HashJoin(INNER, build=left, runtimeFilter) est=201658 actual=24000 (8.4x over)
        Filter est=6000 actual=6000 (on target)
          TableScan est=30000 actual=30000 (on target)
        TableScan est=120000 actual=120000 (on target)
Execution Time: 149.16 ms
Rows Returned: 10
```

The filter is exact — the optimizer knows one of five market segments matches. The join is out by 8.4x, and the aggregate above it inherits the error.

That ratio has a name. The **q-error** of an estimate is how many times wrong it is in whichever direction it is wrong: the larger of estimate÷actual and actual÷estimate, so an estimate that is ten times too high and one that is ten times too low both score 10, and a perfect estimate scores 1. It is the standard way to talk about estimation quality, because it treats over- and under-estimating symmetrically where a plain difference would not. The measurement comes from [`ExecutionProfiler`](../../src/execution/execution-profile.ts), which wraps every operator's sink in a counting sink; [`qErrorOf`](../../src/execution/execution-profile.ts) computes the ratio printed in parentheses.

## Choosing a join

[`joinCandidates`](../../src/execution/physical-planner.ts) builds a list and [`cheapestFor`](../../src/execution/physical-planner.ts) compares each candidate's own cost plus the cost of any remaining required sort. There are three candidates, and two of them are conditional.

**Hash join is always a candidate.** If the condition has equi-join keys it is priced with `hashJoinCost`; if it does not, it is priced as a hash build plus a block nested loop, because that is what the operator degenerates into when every row hashes to the same key.

**Nested loop join is a candidate only when both inputs are small:**

```typescript
if (leftCard + rightCard <= Config.nestedLoopMaxRows) {
```

`nestedLoopMaxRows` is 50,000. Above that the quadratic term is not worth pricing.

**Merge join is a candidate whenever the condition has equi-join keys** and the join is not a cross join. [`mergeJoinCandidate`](../../src/execution/physical-planner.ts) checks whether each side is already sorted on its keys and prices the sorts it would have to add.

Feed the same query three table sizes and watch all three win in turn:

```
     3 rows each: Project <- NestedLoopJoin(INNER, build=left) <- TableScan <- TableScan
   100 rows each: Project <- NestedLoopJoin(INNER, build=left) <- TableScan <- TableScan
  1000 rows each: Project <- HashJoin(INNER, build=left) <- TableScan <- TableScan
  5000 rows each: Project <- MergeJoin(INNER, build=left, sort=LR) <- TableScan <- TableScan
 20000 rows each: Project <- MergeJoin(INNER, build=left, sort=LR) <- TableScan <- TableScan
 30000 rows each: Project <- MergeJoin(INNER, build=left, sort=LR) <- TableScan <- TableScan
```

The arithmetic behind the first flip is short enough to print. [`CostRecorder`](../../src/planner/cost-recorder.ts) proxies the cost model and records every call it makes, so a cost can be decomposed into its terms. At the running query's tiny sizes — build 2, probe 4, output 3:

```
hashJoinCost             = 129.55
blockNestedLoopJoinCost  = 60.57
mergeJoinCostWithSorts   = 100.25
```

The nested loop wins because `costHashInsert` is 37.76 per row, and inserting two rows into a hash table costs more than comparing two rows against four. At the large sizes — build 6,000, probe 120,000, output 201,658 — the recorder shows why that reverses:

```
hashJoinCost(6000, 120000, 201658) = 2464524.6
  hashBuildCost(6000) = 232560.0
  hashProbeCost(120000) = 1020000.0
  joinOutputCost(201658) = 1211964.6
  spillPenalty(6000, 126000) = 0.0

blockNestedLoopJoinCost(6000, 120000, 201658) = 174864984.6
  nestedLoopJoinCost(6000, 120000) = 172800000.0
  joinOutputCost(201658) = 1211964.6
  spillPenalty(6000, 126000) = 0.0
```

Seventy times more expensive, and all of it in the one quadratic term. In this particular plan the nested loop is not even offered, because 6,000 + 120,000 exceeds `nestedLoopMaxRows`.

Every join candidate also carries decorations that the operator will read later, visible in the `EXPLAIN` text through [`describePhysicalNode`](../../src/execution/physical-plan.ts):

| Field | Set by | Meaning |
|---|---|---|
| `buildSide` | [`chooseJoinBuildSide`](../../src/planner/join-build-side.ts) | which input is consumed first |
| `dedupeBuild` | [`isEquiJoinDedupable`](../../src/planner/join-build-side.ts) | build side may keep one row per key |
| `requiresSort` | [`mergeJoinCandidate`](../../src/execution/physical-planner.ts) | which sides the merge join must sort itself |
| `runtimeFilterEntries` | [`runtimeFilterEntries`](../../src/execution/physical-planner.ts) | Bloom filter size, or 0 for none |

## Choosing an aggregate

[`aggregateCandidates`](../../src/execution/physical-planner.ts) is shorter. With no `GROUP BY` there is exactly one candidate, `UngroupedAggregate`, and no decision. With grouping there are up to three:

- `HashAggregate`, always.
- `StreamAggregate`, **only if the child already delivers rows in group-key order**, which `groupOrderAlreadyProvided` checks against the annotated `_sortedBy`.
- `PerfectHashAggregate`, only if [`canUsePerfectHashAggregate`](../../src/planner/aggregate-strategy.ts) says the grouping keys have a small, dense domain.

That last predicate is what changed in the opening plans. It requires every group key to be a plain column reference with known statistics, a product of distinct-value counts no greater than 256, and — through [`hasCompactDomain`](../../src/planner/aggregate-strategy.ts) — either an integer range no wider than 4,096 or at most four distinct values. Three customers grouped by name have three distinct values, so the tiny plan qualifies. Thirty thousand do not.

When it qualifies its node cost is discounted relative to hash aggregation, because `perfectHashAggregateCost` is `hashAggregateCost` multiplied by `perfectHashAggregateCostFactor`, which is 0.5:

```
hashAggregateCost          = 43.53
perfectHashAggregateCost   = 21.77
```

Chapter 36 shows what the executor does with that choice, and it is not what the name suggests.

## Orders that are already satisfied

[`planSatisfiedOrder`](../../src/execution/physical-planner.ts) runs before the table lookup and handles two rewrites that are only visible physically.

A `Sort` whose child already provides the required order **disappears** — the physical planner returns the child. A `Top-N` whose child already provides the order becomes a plain `Limit`, keeping the count but dropping the sort:

```
-> Project (T.A)
  -> Top-N (count: 10, order: T.A ASC)
    -> Project (T.A)
      -> Top-N (count: 100, order: T.A ASC)
        -> Seq Scan on T as T

Physical Plan:
Project
  Limit
    Project
      TopN
        TableScan
```

The inner `Top-N` sorts; the outer one takes ten rows off the front. The logical plan does not record that, which is one of several reasons the two trees are worth reading separately.

## In the code

| Idea | Where |
|---|---|
| The physical tree | [`PhysicalPlanNode`](../../src/execution/physical-plan.ts) |
| Operator types | [`PhysicalNodeType`](../../src/execution/physical-plan.ts) |
| Translation entry point | [`PhysicalPlanner`](../../src/execution/physical-planner.ts) |
| Logical type to operator, plus cost rule | [`descriptorOf`](../../src/planner/plan-node-descriptor.ts) |
| Cardinality and sort-order annotation | [`PlanPropertyAnnotator`](../../src/planner/plan-properties.ts) |
| Join candidate list | [`joinCandidates`](../../src/execution/physical-planner.ts) |
| Aggregate candidate list | [`aggregateCandidates`](../../src/execution/physical-planner.ts) |
| Picking the minimum | [`cheapestFor`](../../src/execution/physical-planner.ts) |
| Cost arithmetic | [`DefaultCostModel`](../../src/planner/cost-model.ts) |
| Cost provenance | [`CostRecorder`](../../src/planner/cost-recorder.ts) |
| Whole-tree cost | [`totalPhysicalCost`](../../src/execution/physical-plan.ts) |
| Plan text you see in `EXPLAIN` | [`physicalPlanToString`](../../src/execution/physical-plan.ts) |
| Measured rows per operator | [`ExecutionProfiler`](../../src/execution/execution-profile.ts) |

## Traps

**`cheapestFor` includes an ordering requirement.** Candidates for a node have the same children, so it compares their node costs plus `residualSortCost`. A more expensive join can win if its output avoids a sort above it. But [`totalPhysicalCost`](../../src/execution/physical-plan.ts) exists separately for callers that need the whole tree, and it has two special cases: an `Empty` node ignores its child, because that subtree exists only to supply a schema and never runs, and a `DependentJoin` multiplies its inner subtree's cost by the outer cardinality, because that subtree runs once per outer row.

**The physical planner runs inside the optimizer for some queries.** [`AggregatePushdown`](../../src/optimizer/passes/aggregate-pushdown.ts) constructs its own `PhysicalPlanner` to price a candidate rewrite against the current plan. An optimizer pass that calls the physical planner is unusual, and it is why that pass can be described as cost-based while the rest are rules.

**A merge join can be chosen when neither side is sorted.** `sort=LR` in the plan text means the operator must sort both inputs itself. That is not a mistake — chapter 35 shows when paying for two sorts still wins.

**`describePhysicalNode` only decorates joins.** Every other operator prints as a bare type name, so `HashAggregate` and `PerfectHashAggregate` are distinguishable in `EXPLAIN` but a `Sort` on one key and a `Sort` on four are not.

## Recap

- The **physical plan** is a second tree, carrying an operator type, an estimated cardinality, and a cost for every node.
- Most logical nodes map to one operator through a **descriptor table**; only `JOIN` and `AGGREGATE` have `physicalType: null` and are decided by cost.
- Costs are computed from **estimated** cardinalities annotated onto the logical tree before planning, so a bad estimate produces a slow plan rather than a wrong one. `EXPLAIN ANALYZE` shows the two side by side.
- A join has up to three candidates: hash, a size-gated nested loop, and an equi-key merge join. `cheapestFor` includes the cost of any ordering still required above the candidate.
- A grouped aggregate has up to three candidates, with **`PerfectHashAggregate` gated on a small dense key domain** and `StreamAggregate` gated on the child already being sorted.
- `planSatisfiedOrder` deletes a `Sort` and downgrades a `Top-N` to a `Limit` when the child's order already satisfies them.

Next: [chapter 30](30-push-based-pipelines.md) explains how that tree of operators becomes a set of running pipelines — and why the data is pushed, not pulled.
