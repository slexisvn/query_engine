# Glossary

Read these definitions as a map back into the book. Where a term describes this engine's particular implementation, the definition says so.

## From SQL to a plan

| Term | Meaning | Start here |
|---|---|---|
| Query engine | Software that turns a description of a requested result into work that produces it. A complete database may also provide transactions, recovery, and other services outside this book. | [1](../00-orientation/01-what-is-a-query-engine.md) |
| Declarative | Describing the requested result while leaving implementation choices to the engine. | [1](../00-orientation/01-what-is-a-query-engine.md) |
| Token / lexer | A token is a recognized word, literal, or punctuation item; the lexer extracts tokens from text. | [5](../01-frontend/05-the-lexer.md) |
| Parser / AST | The parser arranges tokens into an abstract syntax tree reflecting the language's grammar. | [6](../01-frontend/06-recursive-descent-parser.md), [7](../01-frontend/07-the-ast-and-its-limits.md) |
| Binder / scope | The binder resolves names and types; a scope describes which names are visible at a particular point. | [8](../01-frontend/08-binder-scopes-and-names.md) |
| Schema / catalog | A schema describes columns and types. The catalog records available tables, schemas, storage, and related metadata. | [8](../01-frontend/08-binder-scopes-and-names.md) |
| Expression | A computation of a value, such as `price * 2` or `key = 1`. | [9](../01-frontend/09-types-and-expressions.md) |
| Predicate / conjunct | A predicate tests a condition. A conjunct is one term joined to others by `AND`. | [9](../01-frontend/09-types-and-expressions.md), [17](../03-optimizer/17-predicate-pushdown.md) |
| NULL / unknown | `NULL` represents a missing value. Ordinary comparisons involving it generally yield unknown; `WHERE` retains true rows. | [9](../01-frontend/09-types-and-expressions.md) |
| Coercion / cast | Conversion to a type expected by an operation; a cast requests a conversion explicitly. Rules vary by SQL dialect. | [9](../01-frontend/09-types-and-expressions.md) |
| Relation / bag | Here, rows sharing a schema, with duplicates permitted and no inherent order. A mathematical relation in classical relational algebra is a set. | [10](../02-logical-plan/10-relational-algebra.md) |
| Selection / projection | Selection keeps rows (`WHERE`); projection chooses or computes columns (`SELECT`). | [10](../02-logical-plan/10-relational-algebra.md) |
| Logical plan / IR | A representation of relational operations. IR means intermediate representation: the form the optimizer rewrites. | [11](../02-logical-plan/11-the-logical-plan-nodes.md) |
| Physical plan / operator | A physical plan chooses concrete algorithms. Runtime operators carry out those choices. | [29](../04-execution/29-logical-to-physical.md) |
| CTE | A common table expression introduced by `WITH`. Its syntax alone does not require materialization or guarantee reuse. | [12](../02-logical-plan/12-building-the-plan.md) |

## Optimization

| Term | Meaning | Start here |
|---|---|---|
| Pass / rewrite | One transformation or analysis over a plan. A rewrite must preserve the query's specified semantics under its applicability conditions. | [15](../03-optimizer/15-passes-and-fixpoints.md) |
| Fixpoint | A state where rerunning a transformation group makes no further relevant change. A capped loop may stop before reaching it. | [15](../03-optimizer/15-passes-and-fixpoints.md) |
| Pushdown | Moving eligible work closer to its input, commonly to reduce rows or columns processed downstream. | [17](../03-optimizer/17-predicate-pushdown.md) |
| Null-rejecting | A predicate that cannot be true when the relevant input columns are replaced by nulls. | [18](../03-optimizer/18-inference-and-outer-to-inner.md) |
| Cardinality / selectivity | Cardinality is a row count; selectivity is the fraction retained by a condition. Both may be actual values or estimates: specify which. | [23](../03-optimizer/23-cardinality-estimation.md) |
| NDV | Number of distinct values, typically an estimate used to predict matches and groups. | [22](../03-optimizer/22-statistics.md) |
| Histogram / MCV | A histogram summarizes a distribution in buckets. An MCV list records estimated frequencies of selected common values. | [22](../03-optimizer/22-statistics.md) |
| Sketch | A compact, approximate summary of a stream, such as HyperLogLog for distinct counts. | [22](../03-optimizer/22-statistics.md) |
| Cost model | Formulas that assign comparable estimates of work to candidate plans. Cost units are not elapsed time. | [24](../03-optimizer/24-the-cost-model.md) |
| Dynamic programming / memo | Reusing solutions for smaller subproblems; a memo stores those solutions, such as the best plan for a relation set. | [25](../03-optimizer/25-join-ordering.md) |
| Hypergraph / DPhyp | A hypergraph connects sets of relations. DPhyp enumerates connected combinations for join ordering while respecting those connections. | [25](../03-optimizer/25-join-ordering.md) |
| Correlated subquery / decorrelation | A correlated subquery refers to an enclosing query. Decorrelation rewrites that dependency into relational work over the outer values. | [26](../03-optimizer/26-subquery-unnesting.md), [27](../03-optimizer/27-dependent-joins-and-decorrelation.md) |
| Ablation | Removing a component to examine its contribution. For an optional optimization, answers should remain valid even if performance changes. | [28](../03-optimizer/28-plan-properties-and-ablation.md) |
| q-error | Multiplicative estimation error: the larger of estimated/actual and actual/estimated. This engine clamps each count to at least one for this calculation. | [29](../04-execution/29-logical-to-physical.md) |

## Execution and storage

| Term | Meaning | Start here |
|---|---|---|
| Columnar / chunk | Columnar data groups values by column. A chunk is a batch of aligned columns and a row count. | [4](../00-orientation/04-rows-columns-and-chunks.md) |
| Typed array / null bitmap | A typed array stores fixed-width numeric values. A null bitmap separately marks which positions are null. | [4](../00-orientation/04-rows-columns-and-chunks.md) |
| Selection vector | Indices of the rows currently visible in a chunk, allowing filters to avoid copying column values. | [4](../00-orientation/04-rows-columns-and-chunks.md) |
| Materialization | Making values or intermediate results concrete in new storage. Flattening a selection vector is one example. | [4](../00-orientation/04-rows-columns-and-chunks.md) |
| Pipeline / sink | A pipeline passes batches through compatible operators. A sink consumes the output, perhaps retaining state or forwarding it. | [30](../04-execution/30-push-based-pipelines.md) |
| Streaming / blocking | Streaming work can produce output before all input arrives. Blocking work must accumulate an input or partition before producing the relevant output. | [30](../04-execution/30-push-based-pipelines.md) |
| Backpressure | A consumer limits how far its producer can run ahead, keeping queued data bounded. | [30](../04-execution/30-push-based-pipelines.md) |
| Vectorized / SIMD | Vectorized execution processes batches of column values. SIMD is a CPU instruction technique operating on multiple lanes; batching does not imply SIMD. | [31](../04-execution/31-vectorized-execution.md) |
| Zone map / pruning | A zone map summarizes a chunk's value ranges. Pruning skips a chunk only when those summaries prove it cannot match. | [32](../04-execution/32-scans-and-zone-maps.md) |
| Build / probe | Build constructs a join lookup structure; probe searches it with rows from the other input. | [34](../04-execution/34-hash-join.md) |
| Fan-out / skew | Fan-out is the multiplication of matches, such as one customer joining to many orders. Skew is an uneven distribution, such as one key dominating a partition. | [34](../04-execution/34-hash-join.md) |
| Bloom filter | A compact membership filter with possible false positives. With consistent construction and lookup it can prove absence, but not presence. | [34](../04-execution/34-hash-join.md) |
| Semi / anti / mark join | Semi retains left rows with a match; anti retains those without. A mark join adds an indicator whose treatment of unknown depends on the subquery semantics. | [26](../03-optimizer/26-subquery-unnesting.md), [35](../04-execution/35-other-joins.md) |
| Hash / stream aggregate | A hash aggregate groups via lookup state; a stream aggregate finishes consecutive groups on suitably ordered input. | [36](../04-execution/36-aggregation.md) |
| Top-N / heap | Top-N retains only the best N rows under an ordering. A heap keeps the current boundary candidate cheap to find and replace. | [37](../04-execution/37-sorting-and-topn.md) |
| Window / frame / peers | A window computes over related rows without collapsing them. Its frame selects rows for one result; peers tie on all window order keys. | [38](../04-execution/38-window-functions.md) |
| Spill / memory budget | Spilling writes intermediate data to temporary storage. A memory budget triggers it, though this engine's row-based accounting is not a strict process-memory cap. | [39](../04-execution/39-memory-and-spilling.md) |
| Dictionary / RLE / frame of reference | Encodings using string IDs, repeated-value runs, or offsets from a base, respectively. | [41](../05-storage/41-encodings.md) |
| Page / B+ tree / LRU | Here a page stores a chunk. A B+ tree indexes keys to row locations. LRU evicts the least recently used cache entry. | [42](../05-storage/42-pages-caching-and-btree.md) |
| Serialization / backend | Serialization turns in-memory values into bytes. A backend supplies storage operations for a particular environment. | [43](../05-storage/43-serialization-and-spill.md), [44](../05-storage/44-storage-backends.md) |

## Parallelism and distribution

| Term | Meaning | Start here |
|---|---|---|
| Morsel | A small range of input work claimed by a worker at runtime. This engine's active path schedules ranges of chunk indices. | [45](../06-scale/45-morsel-driven-parallelism.md) |
| SharedArrayBuffer / atomics | A buffer accessible to multiple threads; atomic operations coordinate access to shared state such as a work counter. | [46](../06-scale/46-workers-and-shared-memory.md) |
| Fragment / coordinator | A fragment is a portion of a plan assigned for execution. A coordinator arranges distributed work and gathers results. | [47](../06-scale/47-fragments-and-exchange.md) |
| Exchange / shuffle / broadcast | An exchange moves data between execution locations. Shuffle routes by a key; broadcast sends copies to several destinations. | [47](../06-scale/47-fragments-and-exchange.md), [48](../06-scale/48-partitioning-and-pruning.md) |
| Partition | A subset of data. A spill partition, worker merge partition, and distributed table partition serve different purposes despite the shared name. | [34](../04-execution/34-hash-join.md), [48](../06-scale/48-partitioning-and-pruning.md) |
| Heartbeat / failure detector | A heartbeat reports liveness. A detector interprets delays as evidence of failure; a delay alone cannot distinguish a slow machine from a failed one. | [49](../06-scale/49-transport-and-cluster-health.md) |
| WASM / kernel / dispatch | WebAssembly executes compiled modules. A kernel handles a narrow operation; dispatch chooses an available implementation when the caller's conditions permit it. | [54](../07-surfaces/54-wasm.md) |
