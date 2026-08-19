# Architecture decisions

Rationale for the parts of the engine whose shape is not obvious from the code alone.

## Plan pipeline

    SQL → parser → binder → logical plan → logical optimizer → physical planner → pipeline builders → push execution

The logical optimizer produces a *logical* plan annotated with plan properties. The physical planner
turns that into a separate `PhysicalPlanNode` tree that names the operator actually used
(`HashJoin`, `MergeJoin`, `NestedLoopJoin`, `HashAggregate`, `StreamAggregate`, …) and carries its
cost, build side, sort requirements and runtime-filter decision. Builders dispatch on the physical
operator, not on the logical node type.

Logical nodes keep two annotations — `_cardinality` and `_sortedBy` — because they are *plan
properties* (estimated size and interesting orders), not operator choices. They stay
underscore-prefixed on purpose: `planSignature` skips underscore fields, so re-estimating them
cannot prevent an optimizer fixpoint stage from converging.

## Relation names

Column references are resolved by name at execution time: every operator publishes an `ExecSchema`
whose columns carry a `tableAlias`, and `resolveColumnIndex` looks up `alias.column` before falling
back to the bare column name. That fallback is why a derived table or a CTE reference has to put its
own name into the plan. `SELECT u.id FROM u JOIN (SELECT id FROM t) s ON u.id = s.id` has two columns
called `ID`; with the subquery side unqualified, `S.ID` misses, falls back to `ID`, and binds to
`u.id` — the condition degenerates to `u.id = u.id` and the join returns a cross product.

So `LogicalProject` carries an optional `outputAlias` and `LogicalCTEScan` an `alias`, and the
builders stamp that name onto every column of the schema they publish. The planner puts the alias on
the subquery plan's own root projection when it has one and wraps the plan in a projection when it
does not — a subquery ending in `LIMIT`, `DISTINCT` or a set operation — so the name always lands on
a node the optimizer only ever re-parents, never fuses away.

## Join enumeration

`src/optimizer/join-order/` replaces what was previously a `dphyp/` folder containing a DPsub
enumerator under a DPhyp name.

- `dphyp.ts` implements the neighborhood-driven algorithm from Moerkotte & Neumann, *Dynamic
  Programming Strikes Back* (VLDB 2006): `EmitCsg` / `EnumerateCsgRec` / `EnumerateCmpRec` /
  `EmitCsgCmp`. It only ever visits connected subgraphs.
- Subsets of a neighborhood are enumerated by **ascending popcount**
  (`subsetsByAscendingSize`). The `dp.has(...)` guard in `EnumerateCsgRec` depends on smaller
  csgs being emitted before larger ones; descending order silently loses plans — on a star schema
  the full mask is never reached at all.
- `greedy.ts` is the fallback: greedy operator ordering that repeatedly joins the connected pair
  with the smallest estimated result.
- A predicate that cannot become an edge — one whose two operand sides overlap on a relation, or
  one naming an alias that is not a join input — is recorded in `HyperGraph.unrepresentedPredicates`
  and re-attached by `JoinReorder` as a filter above the reconstructed tree. Silently discarding it
  changes the result set, so `addEdge` reports whether it took the predicate rather than returning
  void.
- `enumerator.ts` chooses between them. Exhaustive search runs only when the relation count is at
  most `Config.joinOrderDpMaxRelations`, and aborts to greedy once `Config.joinOrderMaxPairs`
  csg-cmp pairs have been emitted. Without both guards a clique query hangs the optimizer.
- `HyperGraph.adjacencyUnion` is memoised per subset; neighborhood queries are the inner loop.
- Relation count is capped at `BITMASK_RELATION_CAPACITY` (30) because subset masks are 32-bit
  signed integers and `fullMask` must stay positive.

## Physical operator selection

`PhysicalPlanner` **enumerates candidates and picks by cost** rather than short-circuiting on the
first viable operator: every join yields a hash and a nested-loop candidate plus a merge candidate
when equi-join keys exist, and grouped aggregates yield hash plus stream and perfect-hash where
applicable. Sort costs for unsorted merge inputs are folded into the merge candidate's cost, so the
comparison is honest.

This is cost-based operator selection over a fixed logical shape, not a Cascades memo: there is no
transformation-rule search and no alternative *logical* shapes beyond join reordering. That is the
same level DuckDB's physical planner operates at.

## Optimizer stages

`Optimizer` runs *stages*, not a flat pass list. A stage is either one pass applied once, or a
group applied repeatedly until the plan stops changing (`registerFixpoint`).

Predicate pushdown, predicate inference and outer-to-inner conversion each create work for the
others, so they form one fixpoint stage instead of being registered several times in a hand-unrolled
order. `planSignature` is the convergence test; it stringifies bigints so INT64 literals do not throw.

`createDefaultOptimizer` in `optimizer-pipeline.ts` is the single definition of the pass order.
Join reordering is registered unconditionally — the cardinality estimator has defaults for missing
statistics, so gating it behind `ANALYZE` only meant queries ran in written order.

## Composite keys

Every operator that has to treat a tuple of values as one hash key — hash aggregate, stream
aggregate, hash join, `ChunkDeduplicator` (DISTINCT and UNION), window `PARTITION BY`, and the
shuffle exchange — encodes it through `encodeCompositeKey` in `execution/composite-key.ts`. The
encoding is type-tagged and length-prefixed rather than separator-joined, because a separator is not
injective: with `a|b` the tuples `('a|b','c')` and `('a','b|c')` collide, and `String(null)` collides
with the text `'null'`. A collision here is a wrong answer — merged groups, dropped DISTINCT rows,
spurious join matches — not a slowdown, so the single encoder is the invariant, not a convenience.

## Expression evaluation

Three tiers, in order of preference:

1. **WASM kernels** (`tryWasmProject`, the parallel filter path) when WebAssembly is enabled and the
   chunk is large enough.
2. **`columnar-projection.ts`** — a typed-array tier for numeric `+ - *` over fixed-width columns and
   constants. It splits a dense loop from a nullable loop so the common no-null case writes straight
   into a `Float64Array`. Division is deliberately excluded: its divide-by-zero-yields-null rule does
   not vectorise cleanly.
3. **`expression-eval.ts`** — the row-at-a-time closure interpreter, the general fallback.

`value-ops.ts` holds the per-value semantics of every binary and unary operator, including SQL
three-valued logic and interval arithmetic. Both the scalar compiler and the chunk-at-a-time
compiler in `vector-ops.ts` call into it, so those two paths cannot disagree about NULL handling or
numeric coercion by construction. The conformance suites in `tests/execution/vector-ops.test.ts` and
`tests/execution/columnar-projection.test.ts` check the remaining surface: selection vectors, empty
chunks, nullable inputs, and which expression kinds each tier supports.

## Memory safety

Every blocking operator spills, and every limit is measured in bytes (`Config.memoryLimitBytes`) via
`RowMemoryBudget`, which derives a per-row width from the operator's schema — a wide string row
spills sooner than a narrow integer row instead of both being counted the same.

- **Sort** — external merge sort. `SpillStorage` exposes `openReader()` returning a cursor, not
  `read()` returning a whole file: the merge holds one reader per run for its whole duration, and
  whole-file reads put the entire dataset back in memory, making the external sort strictly worse
  than sorting in place.
- **Hash join** — GRACE partitioning with **recursive re-partitioning**: a partition whose spilled
  row count still exceeds the budget is re-split with a depth-salted hash
  (`Config.hashJoinMaxRepartitionDepth` bounds the recursion). Spilled partitions emit their own
  unmatched build rows, because `emitUnmatched` runs before the spilled partitions are probed and
  would otherwise drop them from LEFT and FULL joins.
- **Hash aggregate** — spills *partial group states*, not raw rows, using the existing
  `exportPartials`/`absorbPartials` pair and a tagged-JSON codec that survives bigint group keys.
  Each spilled partition is merged independently at finalize, so peak memory is one partition.
- **Result sink** — the materialising (non-streaming) sink spills collected chunks once the budget is
  exceeded and replays them ahead of the resident ones, so `chunks()` can drain a result larger than
  memory. `toArray()` still builds a full JS array by contract. It takes the pending chunks and
  clears them *before* awaiting the write, because UNION ALL feeds one sink from two pipelines that
  run concurrently: a second `consume` arriving during the await would otherwise find the same
  chunks still listed and spill them a second time. `residentChunks` is named for what it returns —
  only what is still in memory; draining the sink is what yields the whole result.
- **DISTINCT and UNION** — `ChunkDeduplicator` streams while its key set fits the budget, emitting
  each new row as it arrives. Once the budget is exceeded it hash-partitions the key set, spills it
  as plain strings (`encodeCompositeKey` already produces one), and from then on routes arriving rows
  to the matching row partition instead of emitting them. `drain()` reloads one partition's keys at a
  time and filters that partition's rows against them, so a row duplicating one that was emitted
  before the spill is still suppressed. Dropping the key set without recording what had already been
  emitted is what makes the obvious version of this wrong.

`ChunkSerializer` flattens a selection vector before writing, because the wire format has nowhere to
put one: serialising the underlying columns while claiming the filtered row count silently
substitutes the wrong rows, in spill files and distributed transfers alike.

Every operator that spills re-arms its `RowMemoryBudget` when it hands rows to the spill store.
Forgetting the `reset()` does not corrupt results, it just leaves the budget permanently over limit,
which turns an external sort into one run per input chunk and one open file handle per run.

## Runtime filters

A hash join whose build side is estimated at `Config.joinRuntimeFilterMinRows` or more gets a bloom
filter sized from that estimate (`utils/bloom-filter.ts`, Kirsch-Mitzenmacher double hashing). The
probe side consults it *before* materialising a row, which is the expensive part.

The filter is created by the **planner**, not discovered at runtime: a filter built lazily after N
keys have already streamed past would be missing those keys and would produce false negatives —
wrong results, not just lost performance. Only INNER and SEMI joins discard on a miss; every other
join type still has to emit unmatched probe rows.

The size is capped at `Config.joinRuntimeFilterCapacity`. Sizing straight from the estimate lets a
cardinality blow-up ask for a multi-gigabyte bit array; an undersized filter only loses pruning,
since a bloom filter never reports a false negative however full it gets.

## Plan cache

`QueryEngine.planCache` is an LRU keyed by catalog version, statistics state, SQL text and the
serialised parameter values. The parameter values are part of the key because the binder folds
parameters into literals, which lets constant folding, index selection and cardinality estimation
see the actual values — at the cost of not reusing one plan across different parameter values. The
catalog bumps `version` on every schema mutation, so DDL invalidates cached plans without explicit
cache clearing.

## Storage contracts

`TableStorage` is the read surface every table-like source implements; `PagedTableStorage` adds the
page and index surface that only `Table` provides. `isPagedTableStorage` narrows where index scans
and index building need it. The catalog stores `TableStorage`, which is what lets an
`InMemoryRelation` back a registered table without a cast.

`SpillStorage.removeAll()` drops every spilled partition and leaves the store usable for further
spilling — `MemoryStorage` clears its map, `FsStorage` unlinks its spill files but not the directory
it was handed. The directory belongs to `TempDirectoryManager`, which removes the whole tree on
cleanup; having `FsStorage` delete it made the two implementations of one interface disagree about
whether a cleared store still works.

`PageCache` is named for what it is: a read-through LRU over a `PageStore`. It has no pin/unpin, no
dirty tracking and no write-back, so calling it a buffer pool promised a contract it does not
implement.

## Pipeline scheduling

`TaskScheduler` runs at most `concurrency` pipelines at a time and starts a dependent as soon as its
own dependencies finish, rather than waiting for a whole wave to drain. A failing pipeline cancels
the ones still running before the error propagates.

`Pipeline.state` has terminal `FAILED` and `CANCELLED` values alongside `DONE`, so a graph that
stopped early says why. `cancelPipeline` sets `CANCELLED` only from `PENDING` or `RUNNING` — it never
overwrites a pipeline that already finished — and a cancelled pipeline stops being handed out as
ready, so cancellation reaches queued work as well as running work.

## Known gaps

- No Cascades memo: no transformation-rule search over logical alternatives.
- No adaptive re-optimization: cardinality estimates are never corrected from observed runtime rows.
- No transactions, MVCC, WAL or recovery — this is an execution engine, not a DBMS.
- No Arrow or Parquet interop; spill and page formats are the engine's own `ChunkSerializer`.
