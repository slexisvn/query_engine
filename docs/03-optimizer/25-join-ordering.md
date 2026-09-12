# 25. Join ordering: hypergraphs and DPhyp

> After this chapter you will be able to say which join trees the optimizer is allowed to build for a given query, why the answer is not "all of them", and what happens when there are too many tables to search.

## The question

Here is a three-table query and its plan:

```sql
SELECT a.AK, b.BX, c.CK
FROM A a
LEFT JOIN B b ON a.AK = b.BK
LEFT JOIN C c ON (b.BX = c.CK OR b.BX IS NULL)
```

```
-> Project (A.AK, B.BX, C.CK)
  -> LEFT Join (condition: ((B.BX = C.CK) OR (B.BX IS NULL)))
    -> LEFT Join (condition: (A.AK = B.BK))
      -> Seq Scan on A as A
      -> Seq Scan on B as B
    -> Seq Scan on C as C
```

Associativity says `(A ⋈ B) ⋈ C` and `A ⋈ (B ⋈ C)` are the same relation. Build the second tree by hand and run it:

```
-> Project (A.AK, B.BX, C.CK)
  -> LEFT Join (condition: (A.AK = B.BK))
    -> Seq Scan on A as A
    -> LEFT Join (condition: ((B.BX = C.CK) OR (B.BX IS NULL)))
      -> Seq Scan on B as B
      -> Seq Scan on C as C
```

```
original   rows: [[1,10,10],[1,11,null],[2,null,10],[2,null,99],[3,null,10],[3,null,99]]
right-deep rows: [[1,10,10],[1,11,null],[2,null,null],[3,null,null]]
```

Six rows versus four. Associativity does not hold for outer joins in general, and the optimizer must know exactly when it does. Delete the `OR b.BX IS NULL` from the second `ON` clause and it does — and `JoinReorder` performs precisely that rewrite, correctly, on the modified query.

This chapter is about the machinery that tells those two cases apart, and the search that uses it.

## Reordering is a rewrite over a block

[`JoinReorder`](../../src/optimizer/passes/join-reorder.ts) does not touch one join at a time. Its rewriter finds a maximal contiguous region of join nodes — a **join block** — and replans the whole region.

[`JoinBlock.build`](../../src/optimizer/passes/join-reorder.ts) walks down from the topmost join, collecting joins as internal nodes and everything else as leaf **relations**. It also absorbs a `Filter` sitting between two conjunctive joins, pulling its conjuncts into the block. What comes out is a [`JoinTreeNode`](../../src/optimizer/join-order/join-conflicts.ts) tree with relations at the leaves and operators inside, plus a list of **residual** predicates that could not be attached to any operator.

Then [`reorderJoinTree`](../../src/optimizer/passes/join-reorder.ts) checks five bail-out conditions before building anything:

```typescript
if (!tree || block.overflowed || block.relations.length < 2) return root;
if (block.ambiguousAlias) return root;
if (!block.conjunctiveOnly && block.residuals.length > 0) return root;
```

`overflowed` fires above `BITMASK_RELATION_CAPACITY` = 30 relations, because relation sets are 32-bit integers. `ambiguousAlias` fires when two relations in one block share an uppercased alias — every mask lookup is by alias, so a collision would silently mix them up. The last one refuses to reorder a block that has both a non-conjunctive join and predicates it could not place.

Two more checks come after the graph is built:

```typescript
if (graph.size !== block.relations.length || graph.edges.length !== block.edgeCount) return root;
```

If any relation or any predicate failed to make it into the graph, the original tree is returned untouched. **Losing a predicate is how a reordering pass produces wrong answers**, and this is the guard against it.

## Relations as bits

The search represents a set of relations as an integer. [`src/optimizer/join-order/bitmask.ts`](../../src/optimizer/join-order/bitmask.ts) is the whole vocabulary: [`popcount`](../../src/optimizer/join-order/bitmask.ts) counts members, [`bitIndices`](../../src/optimizer/join-order/bitmask.ts) iterates them, [`subsets`](../../src/optimizer/join-order/bitmask.ts) enumerates every subset with the standard `s = (s - 1) & mask` trick, and [`subsetsByAscendingSize`](../../src/optimizer/join-order/bitmask.ts) buckets them by `popcount`.

Bitmask sets are what make the dynamic program practical: subset union is `|`, membership is `&`, and the memo table is a `Map` keyed by an integer.

## The hypergraph

A plain graph — one edge per join predicate, connecting two relations — is enough for inner joins and wrong for everything else. [`HyperGraph`](../../src/optimizer/join-order/hypergraph.ts) generalizes it: a [`HyperEdge`](../../src/optimizer/join-order/hypergraph.ts) connects a *set* of relations to another *set*.

Each edge carries four masks:

```typescript
this.connectLeft = spec.leftMask | (spec.requiredLeft & ~spec.rightMask);
this.connectRight = spec.rightMask | (spec.requiredRight & ~spec.leftMask);
this.fullMask = this.connectLeft | this.connectRight;
this.simple = isSingleRelation(this.connectLeft) && isSingleRelation(this.connectRight);
```

`leftMask` and `rightMask` are the relations the predicate actually mentions. `requiredLeft` and `requiredRight` are relations that must be present *anyway* — the conflict set, computed below. An edge whose two sides are single relations is `simple` and goes into a fast adjacency array; anything else is a `complexEdge` scanned linearly.

[`resolveJoin`](../../src/optimizer/join-order/hypergraph.ts) answers the only question the search asks: given two relation sets, may they be joined, and with what?

```typescript
if (!edge.requiredAt(leftMask, rightMask)) continue;
if (!edge.spans(leftMask, rightMask)) return null;
```

Every edge whose relations are all present in the union must also *fit* — its required left relations on one side, required right on the other. One that does not fit vetoes the join entirely. Beyond that: conjunctive edges (inner and cross) contribute predicates and stack freely; a non-conjunctive edge (any outer, semi, anti, mark, or single join) may appear at most once, and its `swapped` flag records whether the two sets arrived in the operator's original orientation.

## Conflict detection

Now the opening question. Which reorderings are legal is decided before the search runs, by [`computeJoinConstraints`](../../src/optimizer/join-order/join-conflicts.ts), which converts algebraic identities into extra relations bolted onto each edge.

Three properties are tabulated per pair of join types. Each table is built by [`reorderabilityTable`](../../src/optimizer/join-order/join-conflicts.ts), which defaults every cell to `NEVER` and then fills in the legal combinations:

```typescript
export const ASSOCIATIVITY: ReorderabilityTable = reorderabilityTable([
  [CONJUNCTIVE_JOIN_TYPES, LEFT_ARGUMENT_PRESERVING, Reorderability.ALWAYS],
  [[JoinType.LEFT], [JoinType.LEFT], Reorderability.MIDDLE_MUST_BE_NULL_REJECTED],
]);
```

Read the second row against the opening example. A `LEFT` join under a `LEFT` join is associative **only if the upper join's predicate rejects nulls on the middle relation** — the one that would go from being the outer side of the lower join to being the inner side of the upper one. That is exactly the difference between the two queries:

| Upper `ON` clause | Null-rejecting on `B`? | Reordered? |
|---|---|---|
| `b.BX = c.CK` | yes | yes, to right-deep |
| `b.BX = c.CK OR b.BX IS NULL` | no | no |

The test is [`isNullRejecting`](../../src/optimizer/passes/null-rejection.ts) from [chapter 18](18-inference-and-outer-to-inner.md), applied per relation by [`nullRejectedRelations`](../../src/optimizer/join-order/join-conflicts.ts) and stored on each operator as `nullRejectedMask`. `b.BX = c.CK` is unknown when `B.BX` is null, so it rejects; the disjunction is *true* when `B.BX` is null, so it does not.

The other two tables cover the **asscom** identities — the name is the literature's contraction of *associativity* and *commutativity*, for the rewrites that need both at once. Associativity alone moves the parentheses, `(A ⋈ B) ⋈ C` to `A ⋈ (B ⋈ C)`, leaving each relation on the side it was already on. An asscom rewrite also swaps a side, which is how the *middle* relation of a three-way join can end up on the outside: `(A ⋈ B) ⋈ C` to `(A ⋈ C) ⋈ B` is left-asscom, and the mirror image is right-asscom. Both need their own legality table, because a join type that survives one need not survive the other.

`LEFT_ASSCOM` is `ALWAYS` between any two left-argument-preserving joins — inner, cross, left, semi, anti, mark. `RIGHT_ASSCOM` is `ALWAYS` only between conjunctive joins.

[`collectConflicts`](../../src/optimizer/join-order/join-conflicts.ts) walks the tree bottom-up accumulating, for each join type an ancestor might have, the set of relations that must be present. Where a rule holds always, nothing is added. Where it never holds, the whole subtree side is added — pinning the operator in place. Where it holds conditionally, the entry goes into `ascendingConditional` and is resolved against the actual operator's `nullRejectedMask` when the parent is visited.

The result per operator is a `conflictMask`, and [`constraintEdgeSpec`](../../src/optimizer/join-order/hypergraph.ts) folds it into the edge as `requiredLeft` and `requiredRight`. **A legality rule has become a connectivity rule**, and the search below needs to know nothing about outer joins at all — it only has to respect the edges.

Here is the machinery working, on the same shape with a null-rejecting predicate:

```
BEFORE                                          AFTER
-> LEFT Join (condition: (M.ID = S.ID))         -> LEFT Join (condition: (B.ID = M.ID))
  -> LEFT Join (condition: (B.ID = M.ID))         -> Seq Scan on BIG as B
    -> Seq Scan on BIG as B                       -> LEFT Join (condition: (M.ID = S.ID))
    -> Seq Scan on MED as M                         -> Seq Scan on MED as M
  -> Seq Scan on SMALL as S                         -> Seq Scan on SMALL as S
```

And an inner join being pushed below an outer one, which `LEFT_ASSCOM` permits:

```
BEFORE                                          AFTER
-> Join (condition: (B.ID = S.ID))              -> LEFT Join (condition: (B.ID = M.ID))
  -> LEFT Join (condition: (B.ID = M.ID))         -> Join (condition: (B.ID = S.ID))
    -> Seq Scan on BIG as B                         -> Seq Scan on SMALL as S
    -> Seq Scan on MED as M                         -> Seq Scan on BIG as B
  -> Seq Scan on SMALL as S                       -> Seq Scan on MED as M
```

## DPhyp

[`DPhypEnumerator`](../../src/optimizer/join-order/dphyp.ts) is a dynamic program over connected subgraphs. Its memo table maps a relation mask to the best plan found for exactly that set:

```typescript
seedLeaves(): void {
  for (const rel of this.graph.relations) {
    this.dp.set(rel.mask, { plan: rel.plan, cardinality: rel.cardinality,
      totalCost: this.costModel.scanCost(rel.cardinality), mask: rel.mask });
  }
}
```

Then it enumerates every **connected subgraph** and every **connected complement pair** — csg-cmp-pairs, the algorithm's namesake. The outer loop walks relations from highest index down, and the recursion in [`enumerateCsgRec`](../../src/optimizer/join-order/dphyp.ts) and [`enumerateCmpRec`](../../src/optimizer/join-order/dphyp.ts) grows each side through the graph's neighborhood while excluding lower-indexed relations. That exclusion is what makes each pair be generated exactly once instead of once per ordering.

Every pair reaching [`emitCsgCmp`](../../src/optimizer/join-order/dphyp.ts) is costed and kept if it beats what is stored:

```typescript
const candidate = bestJoinOf(leftEntry, rightEntry, resolution, this.costModel, this.cardEstimator);
const existing = this.dp.get(candidate.mask);
if (!existing || candidate.totalCost < existing.totalCost) this.dp.set(candidate.mask, candidate);
```

[`bestJoinOf`](../../src/optimizer/join-order/join-plan.ts) prices the join both ways round when the join type is commutative, and keeps the cheaper — so build-side choice is part of the enumeration, not a later fix-up. Costs come from `hashJoinCost` for every join, whatever algorithm the physical planner will eventually pick; [chapter 24](24-the-cost-model.md) noted that mismatch.

The answer is `dp.get(graph.fullMask)`, the best plan covering every relation. Because the enumeration only ever joins connected sets, **the search never proposes a cross join** unless the graph forces one.

## When the search gives up

DPhyp is exponential in the worst case, and two limits bound it.

**Relation count.** [`selectJoinEnumerator`](../../src/optimizer/join-order/enumerator.ts) compares the graph size against `joinOrderDpMaxRelations` = 14:

```
n=4  -> DPhyp (exhaustive=true)
n=8  -> DPhyp (exhaustive=true)
n=14 -> DPhyp (exhaustive=true)
n=15 -> GreedyJoinOrder (exhaustive=false)
n=18 -> GreedyJoinOrder (exhaustive=false)
```

**Pair budget.** Inside DPhyp, `joinOrderMaxPairs` = 120,000 caps how many csg-cmp-pairs may be emitted. Exceeding it sets `budgetExhausted`, unwinds the recursion, and returns `null`. [`enumerateJoinOrder`](../../src/optimizer/join-order/enumerator.ts) then notices that an exhaustive enumerator returned nothing and reruns with the greedy one:

```typescript
const result = enumerator.solve();
if (result || !enumerator.exhaustive) return result;
return new GreedyJoinEnumerator(graph, costModel, cardinalityEstimator).solve();
```

The cost of staying inside the budget is real. On star queries over the same tables:

```
star n=8   reorder took  33.9 ms
star n=12  reorder took 132.5 ms
star n=14  reorder took 561.5 ms
```

[`GreedyJoinEnumerator`](../../src/optimizer/join-order/greedy.ts) repeatedly joins the pair that produces the fewest rows, breaking ties by cost, until one entry remains. Note the ordering — **cardinality first, cost second**:

```typescript
if (!best || entry.cardinality < best.entry.cardinality
  || (entry.cardinality === best.entry.cardinality && entry.totalCost < best.entry.totalCost)) {
```

Keeping intermediate results small is the heuristic that matters when you cannot search. Greedy is *O(n²)* per step and never backtracks; it can and does miss the optimum.

If even that comes back empty, `reorderJoinTree` has one last bail-out — its eighth — and returns the original tree.

## Rebuilding the plan

DPhyp works on lightweight [`JoinPlan`](../../src/optimizer/join-order/join-plan.ts) records, not logical nodes. [`reconstructPlan`](../../src/optimizer/passes/join-reorder.ts) turns the winner back into a plan:

```typescript
if (!dpPlan.source) return LogicalJoin(dpPlan.joinType, dpPlan.condition, left, right);
return { ...dpPlan.source, condition: dpPlan.condition, children: [left, right] };
```

A join that came from an original operator is rebuilt by **spreading that operator**, so any field the reorderer does not know about — `markColumn`, for instance — survives. A join synthesized from inner predicates gets a fresh node. Residual predicates are wrapped back in a `Filter` above the whole block.

## In the code

| Idea | Where |
|---|---|
| The pass and its bail-outs | [`JoinReorder`](../../src/optimizer/passes/join-reorder.ts), [`reorderJoinTree`](../../src/optimizer/passes/join-reorder.ts) |
| Collecting a join block | [`JoinBlock`](../../src/optimizer/passes/join-reorder.ts) |
| Relation sets as integers | [`src/optimizer/join-order/bitmask.ts`](../../src/optimizer/join-order/bitmask.ts) |
| The graph | [`HyperGraph`](../../src/optimizer/join-order/hypergraph.ts), [`HyperEdge`](../../src/optimizer/join-order/hypergraph.ts) |
| May these two sets join? | [`resolveJoin`](../../src/optimizer/join-order/hypergraph.ts) |
| Reorderability tables | [`ASSOCIATIVITY`](../../src/optimizer/join-order/join-conflicts.ts), [`LEFT_ASSCOM`](../../src/optimizer/join-order/join-conflicts.ts), [`RIGHT_ASSCOM`](../../src/optimizer/join-order/join-conflicts.ts) |
| Conflict computation | [`computeJoinConstraints`](../../src/optimizer/join-order/join-conflicts.ts) |
| Null rejection per relation | [`nullRejectedRelations`](../../src/optimizer/join-order/join-conflicts.ts) |
| The dynamic program | [`DPhypEnumerator`](../../src/optimizer/join-order/dphyp.ts) |
| Costing one candidate | [`bestJoinOf`](../../src/optimizer/join-order/join-plan.ts) |
| The fallback | [`GreedyJoinEnumerator`](../../src/optimizer/join-order/greedy.ts) |
| Choosing between them | [`selectJoinEnumerator`](../../src/optimizer/join-order/enumerator.ts) |

## Traps

**Reordering is silently skipped more often than you would think.** Thirty relations, a repeated alias, a residual predicate next to an outer join, or a predicate that failed to become an edge — each returns the original tree with no diagnostic. If a plan looks unreordered, check the bail-outs before the search.

**The greedy fallback is chosen by relation count, not by difficulty.** A fifteen-relation chain query would be trivial for DPhyp and still gets greedy.

**Join order is costed as if every join were a hash join.** The order is fixed before [chapter 24](24-the-cost-model.md)'s physical planner picks algorithms.

**`BITMASK_RELATION_CAPACITY` is 30, not 32.** The two highest bits are left unused: bit 31 is the sign bit under JavaScript's 32-bit bitwise operators, and [`subsets`](../../src/optimizer/join-order/bitmask.ts) terminates on `s > 0`.

**Conflict detection is not a proof that the rewrite is safe — it is a proof that the *rules* were followed.** The tables encode a specific published set of identities. A join type added without entries in all three tables defaults to `NEVER`, which is conservative and therefore safe; one added with wrong entries is not.

## Exercises

1. Reproduce the opening pair. Build the right-deep plan by hand from the raw plan's nodes, run both through `_collectRows`, and confirm six rows versus four. Then remove `OR b.BX IS NULL` and confirm `JoinReorder` performs the rewrite itself.

2. Add a table to a chain query one at a time and time `JoinReorder`. Where does the curve bend, and does it match the 14-relation threshold or the 120,000-pair budget?

3. Set `QE_JOIN_ORDER_MAX_PAIRS` to 100 and find a query where DPhyp gives up. Confirm from the plan that greedy produced a different, worse order.

4. Give two relations in one join block the same alias so `ambiguousAlias` fires. You will need a subquery. Confirm the plan is left untouched.

5. Change `ASSOCIATIVITY[LEFT][LEFT]` from `MIDDLE_MUST_BE_NULL_REJECTED` to `ALWAYS` and run `npm run test:e2e`. Which test catches you, and how many rows does it report?

## Recap

- `JoinReorder` replans a **join block** — a contiguous region of joins — as a whole, and **bails out entirely** on any of eight guard conditions rather than reordering partially.
- Relation sets are **32-bit masks**, capped at 30 relations.
- Legality is precomputed. Three tables of algebraic identities — associativity, left- and right-asscom — are walked bottom-up into a **conflict mask** per operator, which becomes extra required relations on a hyperedge. The search then only has to respect connectivity.
- `LEFT` under `LEFT` is associative **only when the upper predicate rejects nulls on the middle relation**. That single condition is the difference between a legal rewrite and a four-row answer to a six-row query.
- [`DPhypEnumerator`](../../src/optimizer/join-order/dphyp.ts) enumerates connected subgraph pairs bottom-up, memoized by mask, costing each with `hashJoinCost` and trying both orientations of commutative joins. It never proposes a cross join.
- Above **14 relations** or **120,000 enumerated pairs**, the engine falls back to a greedy enumerator that picks the smallest intermediate result each step and never backtracks.

Next: [chapter 26](26-subquery-unnesting.md) turns subqueries into joins, so that everything in this chapter and the last nine applies to them too.
