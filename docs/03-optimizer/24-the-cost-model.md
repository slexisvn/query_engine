# 24. The cost model

> After this chapter you will be able to compare the modeled costs of candidate operators and distinguish an estimated crossover from a measured one.

## The question

The book's running query, unchanged, over three sizes of the same two tables. Here is the physical plan each time:

```
CUSTOMER=3, ORDERS=4                CUSTOMER=30, ORDERS=100            CUSTOMER=200, ORDERS=1000
total cost = 59.8                   total cost = 1701.3                total cost = 18741.4

Project                             Project                            Project
  TopN                                TopN                               TopN
    PerfectHashAggregate                HashAggregate                      HashAggregate
      NestedLoopJoin(INNER)               NestedLoopJoin(INNER)              HashJoin(INNER)
        Filter                              Filter                             Filter
          TableScan                           TableScan                          TableScan
        TableScan                           TableScan                          TableScan
```

Same SQL, same logical plan, three different physical plans. The join is an equi-join in all three cases — the textbook condition for a hash join — and the engine chooses a nested loop for two of them. The aggregate changes too.

Nothing about the query changed. What changed is a number, and this chapter is about where that number comes from.

## Cost is a scalar with no unit

[`DefaultCostModel`](../../src/planner/cost-model.ts) is a bag of methods, each taking cardinalities and returning a number. There is no notion of milliseconds, bytes, or CPU cycles anywhere in the file. The numbers exist only to be compared with each other.

Every method is built from thirteen constants read from [`Config`](../../src/config.ts):

| Constant | Value | Meaning |
|---|---|---|
| `costTuple` | 1.0 | touching a row at all — the unit everything else is relative to |
| `costOperator` | 0.24 | evaluating one expression |
| `costBuffer` | 2.6 | holding a row in memory |
| `costRowAssembly` | 5.77 | materializing an output row |
| `costHashProbe` | 7.5 | one hash-table lookup |
| `costHashInsert` | 37.76 | one hash-table insertion |
| `costIo` | 17.4 | one row's worth of spilling |
| `costComparison` | 1.25 | one key comparison |
| `costTextComparisonFactor` | 2.0 | multiplier for `VARCHAR` comparisons |
| `costRadixPasses` | 4.0 | passes for a radix sort |
| `costCrossJoinPenalty` | 1000 | per output row of a cross join |
| `costModelSpillThreshold` | memory limit / row width | rows that fit in memory |
| `perfectHashAggregateCostFactor` | 0.5 | discount for the dense-key aggregate |

Read the two hash constants together, because they explain the shape of every join plan in this book. **Inserting into a hash table is modeled as five times more expensive than probing it** — 37.76 against 7.5. That is a claim about the implementation: an insert may resize, rehash, and chain, while a probe is a lookup. This favors building the smaller input when the operator permits either orientation. [`chooseJoinBuildSide`](../../src/planner/join-build-side.ts) also has join-type constraints; chapter 34 explains their implementation.

The oddly specific values — 0.24, 5.77, 37.76, 17.4 — are the current model coefficients. Their decimal precision alone is not evidence of accuracy on your workload. Every one is overridable by an environment variable, which is what makes recalibration on a different machine a configuration change rather than a code change.

## The join formulas

Three join costs matter. Each is a sum of per-row terms times a cardinality.

**Hash join** ([`hashJoinCost`](../../src/planner/cost-model.ts)):

```typescript
hashJoinCost(buildCard, probeCard, outputCard = null): number {
  const emitted = outputCard ?? Math.max(buildCard, probeCard);
  return this.hashBuildCost(buildCard)
    + this.hashProbeCost(probeCard)
    + this.joinOutputCost(emitted)
    + this.spillPenalty(buildCard, buildCard + probeCard);
}
```

Build is `buildCard * (1 + 37.76)`, probe is `probeCard * (1 + 7.5)`, output is `emitted * (5.77 + 0.24)`. **Linear in every input.**

**Block nested loop** ([`blockNestedLoopJoinCost`](../../src/planner/cost-model.ts)):

```typescript
blockNestedLoopJoinCost(buildCard, probeCard, outputCard = null): number {
  const buffered = (buildCard + probeCard) * (this.C_TUPLE + this.C_ROW);
  return buffered
    + this.nestedLoopJoinCost(buildCard, probeCard)
    + this.joinOutputCost(emitted)
    + this.spillPenalty(buildCard, buildCard + probeCard);
}
```

The middle term is `buildCard * probeCard * 0.24` — **quadratic**. Everything else is linear.

A quadratic term with a small coefficient beats a linear term with a large one until the inputs get big enough. Solve for equal-sized inputs and the crossover is exact:

```
n=  100  hash=      5327  nestedloop=      4355  winner=nested loop
n=  140  hash=      7458  nestedloop=      7441  winner=nested loop
n=  141  hash=      7511  nestedloop=      7528  winner=hash
n=  200  hash=     10654  nestedloop=     13510  winner=hash
n= 1000  hash=     53270  nestedloop=    259550  winner=hash
n= 5000  hash=    266350  nestedloop=   6097750  winner=hash
```

**141 rows.** Below that, avoiding 37.76 per build row is worth more than avoiding 0.24 per pair. That is the whole of the opening question: 30 × 100 is below the crossover, 200 × 1000 is above it.

**Merge join** ([`mergeJoinCost`](../../src/planner/cost-model.ts)) walks both inputs once and pays for re-scanning duplicate keys, computed by [`rescannedTuples`](../../src/planner/cost-model.ts) as the output rows beyond the larger input. Pre-sorted inputs avoid setup work, but merge join can win even after paying for sorts, which is why [`mergeJoinCostWithSorts`](../../src/planner/cost-model.ts) takes two booleans and adds a full `sortCost` for each side that is not.

## Spilling is a term, not a mode

An operator that has to hold rows — a hash join building its table, a sort collecting its input — can be handed more rows than fit in its memory budget. When that happens it writes some of them out and reads them back later, and that is **spilling**. It is a normal, planned-for outcome rather than a failure, and [chapter 39](../04-execution/39-memory-and-spilling.md) covers the machinery; here it is one term in an arithmetic expression.

[`spillPenalty`](../../src/planner/cost-model.ts) is the only place the model knows about memory:

```typescript
spillPenalty(residentCard: number, streamedCard: number): number {
  if (residentCard <= this.SPILL_THRESHOLD) return 0;
  return streamedCard * (1 - this.SPILL_THRESHOLD / residentCard) * this.C_IO;
}
```

Zero below the threshold, then rising smoothly: the fraction of data that does not fit, times the rows streaming past, times the I/O constant. Making it continuous rather than a step is deliberate — a step function at the threshold would make plan choice flip on a one-row difference in an estimate that is already approximate.

`costModelSpillThreshold` defaults to the memory limit divided by the default row width, which on this machine is 4,194,304 rows. The small examples in this chapter are below it, so their spill term is zero. Chapter 39 deliberately lowers the budget to exercise spilling.

## Sorts know their key type

[`sortCost`](../../src/planner/cost-model.ts) has two branches:

```typescript
const ordered = keyClass === SortKeyClass.RADIX && card >= Config.radixSortMinRows
  ? card * this.C_OPERATOR * this.RADIX_PASSES
  : card * Math.log2(card) * this.comparisonCost(keyClass);
return this.bufferCost(card) + ordered;
```

A radix sort is *linear*: four passes at 0.24 per row. A comparison sort is `n log n` at 1.25 per comparison, doubled for text. [`sortKeyClassOf`](../../src/planner/cost-model.ts) picks between them:

```typescript
if (types.some(type => type === DataType.VARCHAR)) return SortKeyClass.TEXT;
if (types.length === 1 && RADIX_TYPES.has(types[0])) return SortKeyClass.RADIX;
return SortKeyClass.NUMERIC;
```

`RADIX_TYPES` is `INT32` and `DATE`, and only for a single key. So sorting one integer column is modeled as roughly 1 unit per row, sorting two integer columns as `log2(n)` comparisons at 1.25, and sorting one string column at 2.5 per comparison — a spread of more than an order of magnitude between key types on the same number of rows.

[`topNSortCost`](../../src/planner/cost-model.ts) is the payoff for chapter 21's `TopNFusion`: `card * log2(kept)` comparisons instead of `card * log2(card)`, and only `kept` rows buffered.

## Who asks

The cost model computes numbers; [`PhysicalPlanner`](../../src/execution/physical-planner.ts) makes the decisions. Two node types are genuinely cost-based, and they are the two in the opening plans.

**Joins.** [`joinCandidates`](../../src/execution/physical-planner.ts) builds a list and [`cheapestFor`](../../src/execution/physical-planner.ts) compares each candidate's own cost plus any sort still needed to satisfy its parent's ordering. A hash join is always a candidate — with the block-nested-loop cost substituted when there are no equi-keys, since that is what the operator actually does. A nested loop is a candidate only when `leftCard + rightCard <= Config.nestedLoopMaxRows` (50,000), which caps the damage a bad estimate can do. A merge join is a candidate when the condition has equi-keys, priced with sorts for whichever side is not already ordered.

**Aggregates.** [`aggregateCandidates`](../../src/execution/physical-planner.ts) always offers a hash aggregate. It adds a stream aggregate when the input already arrives sorted on a prefix of the grouping keys, priced at `card * (1 + 0.24)` — no hash table at all. And it adds a perfect-hash aggregate when [`canUsePerfectHashAggregate`](../../src/planner/aggregate-strategy.ts) says the grouping keys are dense enough to index an array directly, priced at half the hash cost. That is the `PerfectHashAggregate` in the three-row plan.

Everything else in the plan gets a fixed cost rule per node type, looked up by [`operatorCost`](../../src/execution/physical-planner.ts).

The plan's total is [`totalPhysicalCost`](../../src/execution/physical-plan.ts), which sums the tree — with one special case:

```typescript
return node.cost + totalPhysicalCost(outer) + Math.max(1, outer.cardinality) * totalPhysicalCost(inner);
```

For a nested loop, the inner subtree's cost is *multiplied* by the outer cardinality, because the inner side is re-executed per outer row. That is the only place in the model where a subtree's cost is not merely summed.

## Reading a cost apart

The numbers a cost model produces are hard to argue with because they arrive as a single scalar. [`CostRecorder`](../../src/planner/cost-recorder.ts) exists to take one apart. It wraps a cost model in a `Proxy` that records every method call:

```typescript
this.model = new Proxy(base, {
  get: (target, property, receiver): unknown => {
    const member: unknown = Reflect.get(target, property, receiver);
    if (typeof member !== 'function') return member;
    return this.wrap(String(property), member as CostMethod);
  },
});
```

Each wrapped call pushes a [`CostTerm`](../../src/planner/cost-recorder.ts) with its method name, arguments, value, and nesting depth, then increments the depth while the real method runs. Because `hashJoinCost` calls `hashBuildCost`, `hashProbeCost`, `joinOutputCost`, and `spillPenalty` **through the proxy**, those calls are recorded as its children. The flat term list is a tree, recoverable with [`topLevelIndexes`](../../src/planner/cost-recorder.ts) and [`childIndexesOf`](../../src/planner/cost-recorder.ts).

Nothing in `src/` uses it. Its consumer is the visualizer's cost breakdown in [`tools/visualizer/src/engine/cost-breakdown.ts`](../../tools/visualizer/src/engine/cost-breakdown.ts), which renders the tree so you can see which term dominates a plan's cost — and it is the fastest way to answer "why did it pick that?" when a plan surprises you.

## In the code

| Idea | Where |
|---|---|
| The constants and formulas | [`DefaultCostModel`](../../src/planner/cost-model.ts) |
| Hash join | [`hashJoinCost`](../../src/planner/cost-model.ts) |
| Nested loop | [`blockNestedLoopJoinCost`](../../src/planner/cost-model.ts), [`nestedLoopJoinCost`](../../src/planner/cost-model.ts) |
| Merge join with sorts | [`mergeJoinCostWithSorts`](../../src/planner/cost-model.ts) |
| Memory pressure | [`spillPenalty`](../../src/planner/cost-model.ts) |
| Sorting | [`sortCost`](../../src/planner/cost-model.ts), [`sortKeyClassOf`](../../src/planner/cost-model.ts), [`topNSortCost`](../../src/planner/cost-model.ts) |
| Aggregation | [`hashAggregateCost`](../../src/planner/cost-model.ts), [`streamAggregateCost`](../../src/planner/cost-model.ts), [`perfectHashAggregateCost`](../../src/planner/cost-model.ts) |
| Candidate generation | [`joinCandidates`](../../src/execution/physical-planner.ts), [`aggregateCandidates`](../../src/execution/physical-planner.ts) |
| Picking the winner | [`cheapestFor`](../../src/execution/physical-planner.ts) |
| Summing a tree | [`totalPhysicalCost`](../../src/execution/physical-plan.ts) |
| Explaining a number | [`CostRecorder`](../../src/planner/cost-recorder.ts) |

## Traps

**The cost model is consulted twice, in two places.** [`JoinReorder`](../../src/optimizer/passes/join-reorder.ts) uses `hashJoinCost` to choose a *logical* join order in chapter 25, assuming hash joins throughout; `PhysicalPlanner` later picks the actual algorithm per join. A join order chosen on the assumption of hash joins may be executed as nested loops.

**Cost is not elapsed time.** Dimensionless units are useful for comparing alternative plans under the same model. Costs for different queries may also suggest different amounts of modeled work, but their ratio is not a predicted runtime ratio: estimates, memory behavior, and unmodeled work can differ.

**A bad cardinality estimate is a bad cost.** Every formula takes cardinalities. [Chapter 23](23-cardinality-estimation.md)'s `sqrt` estimate for `DISTINCT` propagates straight into a join cost, and nothing downstream can detect it.

**`nestedLoopMaxRows` is a hard gate, not a cost.** Above 50,000 combined input rows the nested loop is not offered at all, however cheap the formula says it would be.

**`spillPenalty` uses estimated cardinality, not measured memory.** A plan whose estimates are low will be costed as if it fits in memory and will spill at run time anyway.

## Recap

- Cost is a **unitless scalar** built from configurable model coefficients. Compare candidate plans under the same assumptions; do not read the numbers as milliseconds.
- A hash table insert is **modeled at about five times a probe** (37.76 versus 7.5), favoring the smaller build when the operator permits either side.
- Hash join is **linear** in both inputs; nested loop is **quadratic** with a small coefficient. For equal inputs they cross at **141 rows**, which is why the running query changes algorithm as its tables grow.
- [`spillPenalty`](../../src/planner/cost-model.ts) rises continuously above its threshold. The winning plan can still change where two candidates' costs cross.
- Sort cost depends on the **key class**: linear for a single `INT32` or `DATE` key, `n log n` for numeric, doubled again for text.
- Only **joins and aggregates** are chosen by cost. Everything else has one physical operator and a fixed cost rule.
- [`CostRecorder`](../../src/planner/cost-recorder.ts) proxies the model to record every term as a tree. Nothing in `src/` uses it; the visualizer does, and it is the tool for arguing with a cost.

Next: [chapter 25](25-join-ordering.md) uses these formulas to search a space of join trees, and opens with two trees that are algebraically the same shape and return different answers.
