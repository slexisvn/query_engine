# 44. Storage backends: the same core in a browser

> After this chapter you will be able to explain why 29 lines in `src/runtime/platform.ts` are what let this engine run in a browser, and why the same optimizer and the same operators produce the same plan and the same rows there as they do on Node.

## The question

Import the engine class and construct one:

```javascript
const { QueryEngine } = await import('./dist/engine/query-engine.js');
const { Catalog } = await import('./dist/catalog/catalog.js');
new QueryEngine(new Catalog());
```

```
QueryEngine requires a storageBackend (none provided and no default registered)
```

Now import one more module first — `./dist/index.js`, for nothing but its side effect — and the identical line works:

```
after importing dist/index.js:
  storageBackend  : NodeStorageBackend
  tempSpace       : TempDirectoryManager
  pageStore       : FilePageStore
  spillManager    : FsStorage
```

Import `./dist/browser.js` instead and it also works, with a different storage layer underneath:

```
after importing dist/browser.js:
  storageBackend  : MemoryStorageBackend
  tempSpace       : MemoryTempSpace
  pageStore       : MemoryPageStore
  spillManager    : MemoryStorage
```

An engine that cannot construct itself looks like a defect. It is the load-bearing constraint of this whole part.

## The rule

**No module the engine core reaches imports a Node API.** Not `fs`, not `path`, not `os`, not `worker_threads`. Seventeen files in `src/` import one, and every one of them is in a subsystem that is either optional or explicitly platform-specific:

| Where | Files |
|---|---|
| `src/cli/` | 7 — the terminal front end |
| `src/parallel/` | 5 — worker threads |
| `src/distributed/transport/` | 1 — HTTP |
| `src/wasm/` | 1 — reading `core.wasm` from disk |
| `src/storage/` | 3 — `file-page-store.ts`, `fs-storage.ts`, `temp-directory-manager.ts` |

Those last three are the whole of the platform dependency in storage, and chapters 42 and 43 have already introduced all three. Everything else — the lexer, the binder, the 23 optimizer passes, the physical planner, every operator, the chunk format, the encoders, the serializer, the B-tree — is portable JavaScript.

Bundling both entry points confirms it. The Node bundle from `src/index.ts` pulls in 209 modules; the browser bundle from `src/browser.ts` pulls in 173, and among them:

```
node-ish modules pulled in: (none)
```

Of 30 storage modules in the Node bundle, 26 reach the browser. The four that do not are the three above plus `node-storage-backend.ts`, which imports them.

## Two entry points, one line each

[`setDefaultStorageBackend`](../../src/engine/query-engine.ts) is a module-level setter with a module-level variable behind it:

```typescript
let _defaultBackendFactory: StorageBackendFactory | null = null;

export function setDefaultStorageBackend(factory: StorageBackendFactory): void {
  _defaultBackendFactory = factory;
}
```

The constructor consults it, and refuses rather than guessing:

```typescript
const backend = options.storageBackend ?? _defaultBackendFactory?.(options);
if (!backend) {
  throw new Error('QueryEngine requires a storageBackend (none provided and no default registered)');
}
```

There are exactly two calls to it in the repository. [`src/index.ts`](../../src/index.ts):

```typescript
setDefaultStorageBackend((options) => new NodeStorageBackend(options as StorageBackendOptions));
configureWasmSource(nodeByteSource);
```

and [`src/browser.ts`](../../src/browser.ts):

```typescript
setDefaultStorageBackend(((options: StorageBackendOptions) => new MemoryStorageBackend(options)) as StorageBackendFactory);
configureWasmSource(fetchByteSource);
```

Two injections each. The second is the same pattern for WASM: [`nodeByteSource`](../../src/wasm/node-byte-source.ts) reads `core.wasm` with `fs`, [`fetchByteSource`](../../src/wasm/fetch-byte-source.ts) reads it with `fetch`, and [`configureWasmSource`](../../src/wasm/loader.ts) is how the loader is told which. The engine core imports neither.

This is why the entry-point import is not a formality. `src/index.ts` is not merely a re-export barrel; the two side-effecting calls at its top are the only place the Node platform is named.

## What a backend is

Three factory methods. [`MemoryStorageBackend`](../../src/storage/backend/memory-storage-backend.ts) is twenty-nine lines and is the whole interface:

```typescript
export class MemoryStorageBackend {
  createTempSpace(): MemoryTempSpace { return new MemoryTempSpace(this.options); }
  createPageStore(): MemoryPageStore { return new MemoryPageStore(); }
  createSpillManager(): SpillManager { return new SpillManager(new MemoryStorage()); }
}
```

[`NodeStorageBackend`](../../src/storage/backend/node-storage-backend.ts) is the same three methods returning the file-backed implementations, and it takes an argument the memory one ignores:

```typescript
createPageStore(handle: string): FilePageStore {
  return new FilePageStore(handle, columnAllocator);
}
```

The `handle` is the string a temp space handed out. In Node it is a directory path; in memory it is `mem://query_engine/buffer/ORDERS_0`. Callers never inspect it — [`executeCreateTable`](../../src/engine/query-engine.ts) allocates one and passes it straight through — which is what lets one backend treat it as a path and the other throw it away. A "handle" that is opaque to everyone but its creator is the smallest possible interface between the layer that names things and the layer that stores them.

Notice what a backend is *not*. It does not appear in operator code, in the optimizer, or in the physical planner. Three layers reach for it, always with a handle a temp space issued: `QueryEngine`, for the temp space itself at construction and a page store per `CREATE TABLE`; the [`ExecutionContext`](../../src/execution/execution-context.ts) and the pipeline, join, and aggregate builders, which reach it as `ctx.resources.storageBackend` for the spill manager each spilling operator gets; and the CLI's bulk loaders, for a page store of their own. Each declares a structural type of its own — [`StorageBackendLike`](../../src/engine/query-engine.ts) in `query-engine.ts` names two methods, the one in [`execution-resources.ts`](../../src/execution/execution-resources.ts) names three, and the one the join and aggregate builders declare names only `createSpillManager` — so nothing type-depends on either concrete class.

## Twenty-nine lines

[`src/runtime/platform.ts`](../../src/runtime/platform.ts) is the only file in `src/` that reads an environment variable. All of it:

```typescript
const processEnv: NodeJS.ProcessEnv | null =
  typeof process !== 'undefined' && process.env ? process.env : null;

export function getEnvInt(key: string, fallback: number): number {
  const val: string | undefined = processEnv?.[key];
  return val !== undefined ? parseInt(val, 10) : fallback;
}
```

plus the float, string, and boolean variants and [`getCpuCount`](../../src/runtime/platform.ts).

The `typeof process !== 'undefined'` guard runs **once**, at module load, and the result is captured. Every later read is an optional index into a possibly-null object, which is defined behavior everywhere.

Why that matters more than it looks: [`src/config.ts`](../../src/config.ts) is not a function. It is a plain object literal, built at module load, and every one of its 93 fields comes from these four helpers:

```typescript
export const Config = {
  memoryLimitBytes,
  hashJoinPartitions: env('QE_HASH_JOIN_PARTITIONS', 16),
  pageCachePages: env('QE_PAGE_CACHE_PAGES', 50),
  btreeOrder: env('QE_BTREE_ORDER', 128),
  // ...
};
```

Nearly every module in the engine imports `Config` — the encoders, the page cache, the B-tree, the cost model, the join operators. If even one of those 93 lines said `process.env.QE_...` directly, importing `config.js` in a browser would throw a `ReferenceError` before a single line of the engine ran, and there would be no engine to port. Centralizing the reads means the platform check exists in exactly one place and is written once, correctly, rather than 93 times.

The same file shows the other half of the trick. `getCpuCount` does not ask `os.cpus()`:

```typescript
export function getCpuCount(): number {
  return globalThis.navigator?.hardwareConcurrency ?? SINGLE_THREADED;
}
```

`navigator.hardwareConcurrency` is a *browser* API that modern Node also implements, so one expression covers both platforms and the fallback covers neither:

```
navigator.hardwareConcurrency = 12
parallelWorkers = 11
```

Where a portable API exists, the engine uses the browser's. Where none does — files, directories, worker threads — it goes behind a backend.

## The proof

`tools/visualizer/` is a React application that runs this engine, unmodified, in a browser tab. It is not a client for a server; there is no server. [`Workspace`](../../tools/visualizer/src/engine/workspace.ts) constructs an engine the way any embedder would:

```typescript
const options: EngineOptions = { storageBackend: new MemoryStorageBackend() };
this.engine = new QueryEngine(createDemoCatalog(), options);
```

It passes the backend explicitly rather than relying on the default, because it imports engine modules by source path through a Vite alias rather than through `src/browser.ts`. That alias plugin in [`tools/visualizer/vite.config.ts`](../../tools/visualizer/vite.config.ts) resolves `@engine/...` to `src/...`, and applies the same rule the production bundler does: anything under `parallel/` or `distributed/` resolves to a stub that throws if reached. Everything else compiles as written.

The visualizer then loads TPC-H sample tables into real [`Table`](../../src/storage/table.ts) objects with page stores from that backend, builds real [`BTreeIndex`](../../src/storage/btree.ts) indexes over the resulting pages, and runs the actual optimizer pass by pass so it can render the plan after each one. Every mechanism in chapters 40 through 43 is running — chunking, encoding, zone maps, page identifiers, the LRU, the B-tree — with a `Map` where the filesystem would be.

Which is the point. Run the book's query against both backends:

```
backend: NodeStorageBackend                backend: MemoryStorageBackend
CUSTOMER pages: 2  ORDERS pages: 6         CUSTOMER pages: 2  ORDERS pages: 6
page store: FilePageStore                  page store: MemoryPageStore
```

```
-> Project (C.C_NAME, SUM(O.O_TOTALPRICE))
  -> Top-N (count: 3, order: SUM(O.O_TOTALPRICE) DESC)
    -> Aggregate (group by: C.C_NAME) (aggs: SUM(O.O_TOTALPRICE))
      -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
        -> Filter (condition: (C.C_MKTSEGMENT = 'BUILDING'))
          -> Seq Scan on CUSTOMER as C
        -> Seq Scan on ORDERS as O

Physical Plan:
Project
  TopN
    HashAggregate
      HashJoin(INNER, build=left)
        Filter
          TableScan
        TableScan
```

```
{"C_NAME":"Customer#000969","TOTAL":53055}
{"C_NAME":"Customer#001965","TOTAL":53001}
{"C_NAME":"Customer#002961","TOTAL":52947}
```

Both columns of that comparison are identical, character for character — the same page counts, the same logical plan, the same physical plan, the same rows. Chapter 43 showed the same equality holding under a 64 KB memory limit, where the join and the aggregate actually spill.

## What the browser does not get

Three things, and the code says so plainly rather than degrading quietly.

**Parallel and distributed execution.** Both bundlers replace `src/parallel/` and `src/distributed/` with a module that throws on import. Queries run single-threaded; there is no `parallelWorkers` path to take even though `getCpuCount` returns a real number.

**Spilling that frees memory.** `MemoryStorage` holds serialized bytes in a `Map`. An operator that spills gets a smaller working set — the bytes are encoded and the operator holds one partition at a time — but the process footprint does not drop the way it does with `FsStorage`.

**Durability of any kind.** `MemoryPageStore` is a `Map` on the heap. There is no persistence layer here on either platform — `FilePageStore` writes into a temp directory that `close()` deletes — but on Node the pages at least outlive the process's memory pressure.

## In the code

| Idea | Where |
|---|---|
| The registration hook | [`setDefaultStorageBackend`](../../src/engine/query-engine.ts) |
| What the engine assumes a backend has | [`StorageBackendLike`](../../src/engine/query-engine.ts) |
| Node entry point | [`src/index.ts`](../../src/index.ts) |
| Browser entry point | [`src/browser.ts`](../../src/browser.ts) |
| Files, directories, and `.spill` | [`NodeStorageBackend`](../../src/storage/backend/node-storage-backend.ts) |
| Maps and labels | [`MemoryStorageBackend`](../../src/storage/backend/memory-storage-backend.ts) |
| The only environment reads | [`src/runtime/platform.ts`](../../src/runtime/platform.ts) |
| CPU count without `os` | [`getCpuCount`](../../src/runtime/platform.ts) |
| 93 settings built at module load | [`Config`](../../src/config.ts) |
| The other injected dependency | [`configureWasmSource`](../../src/wasm/loader.ts) |
| Bundling and stubbing | [`scripts/build.js`](../../scripts/build.js) |
| An engine in a browser | [`Workspace`](../../tools/visualizer/src/engine/workspace.ts) |

## Traps

**Importing a deep engine module is not enough.** Reaching for `src/engine/query-engine.js` directly gives you an engine class with no backend. Either import an entry point for its side effect or pass `storageBackend` in the options, as the visualizer does.

**The default is process-global and last-write-wins.** `_defaultBackendFactory` is one module-level variable. Importing both entry points into the same process leaves whichever ran last in charge — which is why the measurements in this chapter run in separate processes.

**Node-only code is stubbed, not tree-shaken.** The browser bundle contains a module that throws `parallel/distributed execution is not available in the browser build`. A code path that reaches it fails at import time with that message rather than silently doing nothing.

**`getEnvInt` does not validate.** `parseInt` on a non-numeric value yields `NaN`, and `NaN` propagates into whatever the setting drives. `QE_PAGE_CACHE_PAGES=lots` gives the LRU a `NaN` capacity, and since `size > NaN` is always false it never evicts — a thousand pages go in and a thousand stay. A typo turns a bounded cache into an unbounded one, silently.

**`process.env` is captured once at module load.** Setting an environment variable after `platform.js` has been imported changes nothing, and neither does setting one after `config.js` has been evaluated — `Config` fields are values, not getters. Tests that need a different setting assign to `Config` directly, which is what [`tests/e2e/column-encoding-differential.test.ts`](../../tests/e2e/column-encoding-differential.test.ts) does.

## Exercises

1. Reproduce all three opening results, each in its own `node` process. Then try importing both entry points in one process and predict which backend you get.

2. Write a third backend — one that keeps pages in a `Map` but spills to files — and pass it to `QueryEngine` in options. How many lines is it, and how many files did you have to change outside it?

3. Add a line to a core module that reads `process.env` directly. Run `node scripts/build.js` and inspect `dist/index.browser.js` for the reference, then load it in a browser and describe the failure.

4. Run `npm run viz`, load the sample data, and run the book's query. Open the browser console and confirm the storage backend is `MemoryStorageBackend`. Then find the point in the UI where a page identifier from chapter 40 is visible.

5. `getCpuCount` returns `navigator.hardwareConcurrency`. Find every setting in `Config` that depends on it and say what each would do on a platform where it is absent.

## Recap

- The engine core imports **no Node API**. Seventeen files in `src/` do, and every one is in `cli/`, `parallel/`, `distributed/`, `wasm/`, or one of the three platform-specific storage files.
- A **storage backend** is three factory methods — temp space, page store, spill manager — and the `handle` string that connects them is opaque to everyone except the temp space that issued it.
- [`setDefaultStorageBackend`](../../src/engine/query-engine.ts) is called exactly twice: once in `src/index.ts` with a Node backend, once in `src/browser.ts` with a memory backend. The constructor **throws rather than guessing** if neither ran.
- [`src/runtime/platform.ts`](../../src/runtime/platform.ts) is 29 lines and the **only** place the engine reads an environment variable. Because `Config` is an object literal evaluated at import time and nearly every module imports it, one direct `process.env` read anywhere would break the browser build entirely.
- The visualizer at `tools/visualizer/` runs this engine in a browser tab with `MemoryStorageBackend`, and the same query produces the **same logical plan, the same physical plan, and the same rows** on both platforms — spilled or not.

That completes Part 5. Storage is a set of interfaces with two implementations each, and the engine above them cannot tell which one it has. Next: Part 6 opens with [chapter 45](../06-scale/45-morsel-driven-parallelism.md), "Morsel-driven parallelism", and the first thing it needs is a subsystem the browser build stubs out.
