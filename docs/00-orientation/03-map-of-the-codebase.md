# 3. A map of the codebase

> After this chapter you will be able to find the source responsible for a query stage and follow the main dependencies without reading every file.

## The question

The source spans several subsystems. Opening them all at once is difficult; start by following one query and use the rest of this chapter as a lookup map.

The answer is that the directory layout is not arbitrary. Five directories carry the six compilation stages from chapter 1, in order — physical planning and execution share one — and two more hold what every stage sits on. Everything else is either a runtime service they use or an alternative front door onto the same machinery.

## The spine

Read these seven in this order and you have followed a query from text to rows:

```
src/parser/      SQL text        -> syntax tree
src/binder/      syntax tree     -> resolved names and types
src/planner/     resolved query  -> logical plan
src/optimizer/   logical plan    -> better logical plan
src/execution/   logical plan    -> physical plan -> rows
src/storage/     how bytes are laid out underneath all of it
src/catalog/     what tables exist and what the data looks like
```

`src/engine/query-engine.ts` sits above them and is the only file that touches all seven. Its [`compileUncached`](../../src/engine/query-engine.ts) method is the five-line spine quoted in chapter 1. **If you read one file before any other, read that one** — not for the details, but because it names every stage and shows the order.

## Where the complexity actually is

The directories organize different kinds of work. Read this inventory when a chapter sends you to a subsystem; there is no need to memorize it.

| Directory | What is in there |
|---|---|
| `execution/` | operators, physical planning, pipelines, expression evaluation |
| `optimizer/` | 23 passes, join ordering, decorrelation |
| `distributed/` | fragments, exchange, coordinator, transport |
| `storage/` | columns, chunks, encodings, pages, B-tree, spilling |
| `planner/` | logical plan nodes, cardinality, cost model |
| `parallel/` | worker threads and the scheduler that feeds them |
| `wasm/` | AssemblyScript kernels and their loader |
| `parser/` | lexer, parser, AST |
| `binder/` | scopes, type inference, expression binding |
| `cli/` | REPL and data loaders |
| `catalog/` | table metadata and statistics sketches |
| `dataframe/` | the lazy DataFrame API |
| `engine/` | the orchestrator |
| `utils/` | bitmap, bloom filter, hash, LRU, priority queue |

Two observations worth carrying into the rest of the book.

**Execution carries many responsibilities.** Beyond the central algorithm, an operator may need null handling, memory accounting, spilling, and several input or output paths. Chapter 34 introduces [`hash-join.ts`](../../src/execution/operators/hash-join.ts) by separating a small build/probe example from those additional responsibilities.

**This engine's parser is relatively small.** Its deliberately limited SQL dialect fits into a few files. That does not make parsing or name resolution unimportant: a broader dialect can require a much larger frontend. In this repository, most of the implementation work is in optimization and execution.

## Which way the arrows point

The stages depend downward and, with four exceptions, only downward:

```mermaid
flowchart TD
  parser --> storage
  binder --> parser
  binder --> storage
  planner --> binder
  planner --> catalog
  optimizer --> planner
  optimizer -.->|one pass| execution
  execution --> planner
  execution --> binder
  execution --> storage
  catalog --> storage
  storage --> utils
```

Every pass but one knows about the planner's node types and nothing about operators. The planner knows about bound expressions but nothing about how a filter is evaluated. Storage knows about none of them. That layering is what makes the pass architecture in Part 3 possible: a pass can be added, removed, or reordered without touching anything below it.

The four edges that break the pattern are worth naming, because a map that hides its exceptions is not a map:

| Edge | File | Why |
|---|---|---|
| `optimizer` → `execution` | [`aggregate-pushdown.ts`](../../src/optimizer/passes/aggregate-pushdown.ts) | it builds a physical plan for each alternative and compares their costs |
| `planner` → `execution` | [`plan-node-descriptor.ts`](../../src/planner/plan-node-descriptor.ts) | it describes both logical and physical nodes uniformly, so it imports the physical node types |
| `planner` → `distributed` | [`aggregate-decomposition.ts`](../../src/planner/aggregate-decomposition.ts) | type-only, for the partial/final aggregate split that chapter 47 uses |
| `utils` → `storage` | [`bloom-filter.ts`](../../src/utils/bloom-filter.ts) | type-only, for `ColumnValue` |

The bottom two are `import type`, which disappears at compile time and creates no runtime dependency. The other two are real, and the first is the interesting one. `AggregatePushdown` decides whether pushing an aggregate below a join is worth it by planning both shapes and costing them — it constructs a [`PhysicalPlanner`](../../src/execution/physical-planner.ts) and calls [`totalPhysicalCost`](../../src/execution/physical-plan.ts) on the result. So one pass out of 23 does reach up into execution, and it is a cost-based decision that needs the physical layer to answer at all. Chapter 24 comes back to it.

## Everything else

The remaining directories are not stages. They are alternatives and services.

**`src/dataframe/`** — a second front door, and one shared service. Instead of writing SQL you build a query with method calls, lazily, and it compiles to the same logical plan the SQL path produces. Chapter 50 covers it. The important structural fact is that it is a *peer* of the parser and binder, not a wrapper around them: both routes converge on `LogicalPlanNode` and share everything after that. The name undersells it, though — [`InMemoryRelation`](../../src/dataframe/in-memory-relation.ts) also lives here, and it is what turns rows into chunks for *both* routes, so `query-engine.ts` and `engine-entry.ts` import from this directory whether or not you ever touch the DataFrame API.

**`src/parallel/`** — worker threads and shared-memory arenas. It parallelizes single-machine execution by handing each thread a **morsel**, a small range of the input claimed from a shared counter rather than assigned in advance. Chapters 45 and 46.

**`src/distributed/`** — a separate concern from `parallel/`, despite the overlap in vocabulary. This one splits a plan into fragments that run on different *processes or machines*, connected by exchange operators over an HTTP transport. Chapters 47 through 49. That it is 4,859 lines — larger than the optimizer's pass collection — is a reasonable measure of how much distribution costs.

**`src/wasm/`** — AssemblyScript kernels for filters, arithmetic, and aggregates, plus the loader that instantiates them. Chapter 54 is honest about what fraction of execution actually reaches them.

**`src/cli/`** — the REPL from chapter 2 and the CSV and JSON loaders.

**`src/storage/backend/`** and **`src/runtime/platform.ts`** — the seam that lets the same core run in Node and in a browser. `platform.ts` centralizes the guarded environment reads used by configuration. Chapter 44.

**`src/utils/`** — small shared data structures, with the type-only storage dependency noted above: a bitmap, a Bloom filter, a hash function, an LRU cache, and a priority queue. When an operator needs one of these it imports from here rather than growing its own, while joins and aggregates share their more specialized keyed hash table in [`src/execution/hash-table.ts`](../../src/execution/hash-table.ts).

## Finding things

Three conventions make navigation predictable.

**`tests/` mirrors `src/` one-to-one.** `src/optimizer/passes/predicate-pushdown.ts` is tested by `tests/optimizer/passes/predicate-pushdown.test.ts`. There are 190 test files. When you want to know what a component is supposed to do, its test is usually a better answer than its implementation, because a test states intent and an implementation states mechanism.

**End-to-end tests live in `tests/e2e/` and nested `e2e/` directories.** The Vitest configuration includes both. Some assert known results; others compare optimizer or execution variants. Check which reference a test actually uses before treating it as independent evidence.

**Names are literal.** An optimizer pass file is named after the pass class it exports, an operator file after the operator. There is no `misc/` and no grab-bag `common/` directory; the three catch-all files that do exist are each scoped to the directory they sit in — [`builder-utils.ts`](../../src/execution/builders/builder-utils.ts) for the operator builders, [`join-utils.ts`](../../src/execution/join-utils.ts) for the join operators, [`cli-common.ts`](../../src/cli/cli-common.ts) for the CLI entry points. So grepping for a concept usually finds the file directly.

Concretely, to answer "how does X work":

| You want | Look at |
|---|---|
| what an optimizer pass does | `tests/optimizer/passes/<pass>.test.ts` first, then the source |
| how an operator behaves on nulls or outer joins | `tests/execution/operators/<op>.test.ts` |
| what SQL is supported | [`src/parser/lexer.ts`](../../src/parser/lexer.ts) keyword list, then `tests/e2e/` |
| what a config knob does | [`src/config.ts`](../../src/config.ts) — every knob is one line with its default |
| the order passes run in | [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) |

## In the code

| Landmark | File |
|---|---|
| The orchestrator | [`QueryEngine`](../../src/engine/query-engine.ts) |
| The one-page summary of the pipeline | [`compileUncached`](../../src/engine/query-engine.ts) |
| Every tunable constant | [`src/config.ts`](../../src/config.ts) |
| Pass order | [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) |
| Logical node type union | [`src/planner/logical-plan.ts`](../../src/planner/logical-plan.ts) |
| Physical node types | [`src/execution/physical-plan.ts`](../../src/execution/physical-plan.ts) |
| Public API surface | [`src/index.ts`](../../src/index.ts) |

## Traps

**`src/parallel/` and `src/distributed/` are different systems.** Both talk about workers and partitions. The first uses threads inside one process and shared memory; the second uses separate processes and a network transport. A technique from one does not transfer to the other, and mixing up their vocabulary is the fastest way to misread Part 6.

**`src/execution/` contains both planning and execution.** The physical planner lives there, not in `src/planner/`, because choosing an algorithm requires knowing which algorithms exist. It is a defensible split, but it means "planning" happens in two directories.

**The line counts above will drift**, as the table's lead-in says. A chapter that cites one of them as a fact is citing a measurement, not an invariant.

## Recap

- Seven directories are the compilation pipeline, in order: **parser, binder, planner, optimizer, execution**, over **storage** and **catalog**.
- [`src/engine/query-engine.ts`](../../src/engine/query-engine.ts) is the only file that touches all of them, and is the right first read.
- **Execution is the largest subsystem**, roughly twice the optimizer. Parsing is the smallest interesting one.
- Dependencies point **downward**, with four documented exceptions, two of which are type-only. The one that matters is a single optimizer pass that costs alternatives by building physical plans for them.
- `parallel/` and `distributed/` are separate systems that share vocabulary and nothing else.
- `tests/` mirrors `src/` one-to-one, and a component's test is usually the clearest statement of what it is meant to do.

Next: [chapter 4](04-rows-columns-and-chunks.md) goes one level below all of this, to the data structure every operator in the engine actually manipulates.
