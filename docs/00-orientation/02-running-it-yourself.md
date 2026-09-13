# 2. Running it yourself

> After this chapter you will have run the book's query, inspected its plan, and know how to rebuild after changing code.

## The question

Can you get Alice's total of 350 and Carol's total of 300 on your own machine? Start with that result. The code-navigation and build details below will be easier to place once a query has run.

## Your first result

You need a checkout of this repository, Node.js 22 or later, and npm. Node 22 is the version used by the book's CI check. Open a terminal **in the repository root**, the directory containing `package.json`. All commands in this chapter run from there on PowerShell as well as a Unix shell.

```bash
node --version
npm ci
npm run book:query
```

The last command compiles the TypeScript and runs [first-query.mjs](../examples/first-query.mjs). It loads the checked-in [customer.csv](../examples/customer.csv) and [orders.csv](../examples/orders.csv), runs the query, checks the answer, and prints a table containing:

| C_NAME | TOTAL |
|---|---:|
| Alice | 350 |
| Carol | 300 |

No database server, generated benchmark dataset, or worker processes are needed. The sample's numeric columns contain integers, so the CSV loader infers `INT32`; writing `100.0` instead of `100` does not force a floating-point type.

Now inspect the transformation:

```bash
npm run book:plan
```

[inspect-plan.mjs](../examples/inspect-plan.mjs) prints the original logical plan, the passes that visibly changed it, the optimized plan, and the physical plan. Look for the filter on the customer input and the `TopN` combining ordering with the limit. Exact costs and algorithm choices depend on statistics and the checked-out engine version.

## The REPL

A **REPL** reads a command, evaluates it, prints the result, and waits for another. To explore SQL interactively, build the command-line bundle and load the same files:

```bash
npm run build
npm start -- docs/examples/customer.csv docs/examples/orders.csv
```

At the `sql>` prompt, paste:

```sql
SELECT c.C_NAME, SUM(o.O_TOTALPRICE) AS TOTAL
FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
WHERE c.C_MKTSEGMENT = 'BUILDING'
GROUP BY c.C_NAME ORDER BY TOTAL DESC LIMIT 10;
```

The answer is the same two totals. The CLI also reports an execution time; yours need not match another machine's. Table names come from the file name without its extension, uppercased: `customer.csv` becomes `CUSTOMER`.

SQL runs when you end the statement with a semicolon. Until then the prompt becomes `...>` and keeps buffering. **Meta commands** begin with a dot and run immediately, with no semicolon:

| Command | What to inspect |
|---|---|
| `.tables` | loaded tables, actual row counts, and columns |
| `.status` | whether WASM, parallel, and distributed modes are enabled |
| `.explain SELECT * FROM CUSTOMER` | a compact optimized logical plan |
| `.help` | available meta commands |
| `exit` or `quit` | leave the REPL |

SQL `EXPLAIN SELECT * FROM CUSTOMER;` uses a more detailed printer and adds a physical plan. `EXPLAIN ANALYZE` executes the query and includes runtime measurements. [Chapter 13](../02-logical-plan/13-reading-explain.md) explains how to read these outputs.

## The library

For your own experiment, save this as `try-query.mjs` **in the repository root**, then run `node try-query.mjs` after `npm run build:ts`:

```javascript
import { createEngine, registerTable } from './dist/index.js';

const engine = createEngine();
try {
  registerTable(engine, 'CUSTOMER', [
    { C_CUSTKEY: 1, C_NAME: 'Alice', C_MKTSEGMENT: 'BUILDING' },
    { C_CUSTKEY: 2, C_NAME: 'Bob', C_MKTSEGMENT: 'MACHINERY' },
    { C_CUSTKEY: 3, C_NAME: 'Carol', C_MKTSEGMENT: 'BUILDING' },
  ]);
  console.log((await engine.run('SELECT C_NAME FROM CUSTOMER ORDER BY C_CUSTKEY')).rows);
} finally {
  await engine.close();
}
```

The output contains Alice, Bob, and Carol in that order. Importing the Node entry point also registers its storage backend. Some later examples import individual modules from `dist/`; those must still load `./dist/index.js` or supply a backend explicitly. [Chapter 44](../05-storage/44-storage-backends.md) explains this platform setup.

The compiler stages are callable separately:

```javascript
const ast = engine.parseSQL(sql);
const bound = engine.bind(ast);
const plan = engine.plan(bound);
const optimized = engine.optimize(plan);
```

This excerpt assumes an engine with tables already registered and a `sql` string. Calling `optimize` directly does not collect statistics for you. The runnable `book:plan` example warms statistics first, then uses the optimizer's observer to print changes. [Chapter 28](../03-optimizer/28-plan-properties-and-ablation.md) explains why collecting statistics can replace an optimizer you customized earlier.

## The visualizer

Install the visualizer's separate dependencies once, then start it:

```bash
npm --prefix tools/visualizer ci
npm run viz
```

Open the local URL printed by Vite. The app runs the engine in a browser, displays a plan graph, and lets you inspect optimizer steps. [Chapter 51](../07-surfaces/51-tools.md) gives a guided exercise. On a first read, the REPL and `book:plan` are sufficient; the visualizer is another way to inspect the same concepts.

## Which build to run

There are two build commands because there are two forms of output:

| What you want to run after an edit | Build command |
|---|---|
| library modules under `dist/`, book examples, or engine tests | `npm run build:ts` |
| bundled CLI or packaged browser build | `npm run build` |
| updated AssemblyScript kernels | `npm run build` |

`build:ts` runs TypeScript compilation only. The full build also bundles entry points with esbuild and compiles `dist/core.wasm`. Rebuilding only TypeScript leaves an older CLI bundle in place. If a source edit seems to do nothing in the CLI, check which build you ran.

The test scripts already build the per-file output:

```bash
npm run test:docs
npm run test:unit
npm run test:e2e
```

The engine's test resolver maps source imports to `dist/`. Running Vitest directly after editing source can therefore test stale output. End-to-end tests include SQL examples, semantic assertions, and comparisons between alternative execution paths; they do not all use an external reference database.

<details>
<summary>Optional: worker flags and the current bundle limitation</summary>

The CLI enables WASM by default; the library requires an explicit `enableWasm()` call. Successful loading does not imply that a particular query uses a WASM kernel. [Chapter 54](../07-surfaces/54-wasm.md) separates those two observations.

In this checkout, `npm start -- --parallel ...` and `--distributed` cannot locate the worker scripts through the bundle. A failure can misleadingly report that WASM is required even after WASM has loaded. The early chapters use single-threaded execution and do not need these flags.

For the experiments in Part 6, save this as `run-cli.mjs` in the repository root after a full build:

```javascript
import './dist/index.js';
import { start } from './dist/cli/index.js';
start();
```

Then use `node run-cli.mjs --parallel docs/examples/customer.csv`. This entry point uses the per-file worker paths. Check `.status` for the actual enabled state. [Chapter 46](../06-scale/46-workers-and-shared-memory.md) traces the failure and the two worker pools.

</details>

## In the code

| Purpose | Entry point |
|---|---|
| first result | [first-query.mjs](../examples/first-query.mjs) |
| plan observation | [inspect-plan.mjs](../examples/inspect-plan.mjs) |
| library construction | [`createEngine`](../../src/engine-entry.ts) |
| Node platform setup | [src/index.ts](../../src/index.ts) |
| REPL | [`startREPL`](../../src/cli/repl.ts) |
| CSV loading | [`CSVLoader`](../../src/cli/loaders/csv-loader.ts) |
| bundled output | [scripts/build.js](../../scripts/build.js) |
| test resolver | [vitest.config.ts](../../vitest.config.ts) |

## Traps

**The working directory matters.** Run commands from the repository root. Put snippets importing `./dist/...` there too; a file inside `docs/` needs different relative imports.

**A startup message is not a measurement of work.** An enabled subsystem may have thresholds the query does not reach. Use the relevant chapter's instrumentation when investigating acceleration.

**The tiny example is for understanding.** Two correct totals verify the setup; they do not demonstrate throughput or parallel speedup.

## Recap

- `npm run book:query` builds and verifies a first result using checked-in data.
- `npm run book:plan` shows the query's plans and visible optimizer changes.
- The REPL needs semicolons for SQL and none for meta commands.
- The library exposes compiler stages; the visualizer provides a graph view.
- Rebuild the bundle when testing source changes through the CLI.

Next: [chapter 3](03-map-of-the-codebase.md) maps the directories used by these entry points.
