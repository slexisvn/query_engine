# 2. Running it yourself

> After this chapter you will have the engine running three different ways, and you will know which build command to use so that the code you edit is the code that runs.

## The question

Chapter 1 printed a plan tree and asserted things about it. You should not take that on trust, and you will not learn much if you do. Every plan, result, and number in this book came out of a terminal, and all of them are reproducible in a few minutes.

There are three ways into this engine, and they suit different questions:

| Question | Use |
|---|---|
| "What does this query return, and what plan does it get?" | the REPL |
| "What happens if I call this function with that argument?" | the library |
| "Which optimizer pass changed the plan, and how?" | the visualizer |

This chapter sets up all three. It also explains the one thing about this repository's build that will otherwise cost you an afternoon: there are two builds, and they do not produce the same thing.

## Building

```bash
npm install
npm run build
```

That is the command to use. It runs three steps, visible in `package.json`:

1. `node scripts/build.js` — bundles three entry points with esbuild: `dist/index.node.js` (the library), `dist/index.browser.js` (the browser build), and `dist/index.cli.js` (the command-line tool).
2. `npm run build:wasm` — compiles the AssemblyScript sources under [`src/wasm/assembly/`](../../src/wasm/assembly/aggregate.ts) into `dist/core.wasm`.
3. `tsc -p tsconfig.build.json` — compiles every TypeScript file individually into a matching `.js` beside it under `dist/`, so `src/optimizer/optimizer.ts` becomes `dist/optimizer/optimizer.js`.

**Steps 1 and 3 produce different artifacts from the same source, and this is the trap.** There is also a faster command:

```bash
npm run build:ts
```

which runs only step 3. It is much quicker, and it is what the test suite uses. But it does **not** refresh the bundles. So if you edit an optimizer pass and then run the CLI, you will be running the bundle from whenever you last ran the full `npm run build` — and your change will appear to have done nothing.

The rule is short:

| You changed | Run |
|---|---|
| anything, and want to run tests or the library examples | `npm run build:ts` |
| anything, and want to run the CLI or the browser build | `npm run build` |
| the AssemblyScript kernels | `npm run build` |

When in doubt, run the full build. It takes a few seconds longer and removes the entire class of confusion.

## The REPL

The command-line tool takes data files as arguments and drops you into a SQL prompt. Give it a CSV:

```bash
npm start -- customer.csv orders.csv
```

Table names come from file names, uppercased, so `customer.csv` becomes `CUSTOMER`. Both `.csv` and `.json` are supported, dispatched by extension in [`src/cli/loaders/loader-factory.ts`](../../src/cli/loaders/loader-factory.ts).

Here is a real session, using the three customers and four orders from chapter 1:

```
[wasm] WebAssembly acceleration enabled
[load] CUSTOMER (3 rows) from customer.csv
[load] ORDERS (4 rows) from orders.csv
sql> .tables

  CUSTOMER (3 rows) - [C_CUSTKEY, C_NAME, C_MKTSEGMENT]
  ORDERS (4 rows) - [O_ORDERKEY, O_CUSTKEY, O_TOTALPRICE]

sql> SELECT c.C_NAME, SUM(o.O_TOTALPRICE) AS TOTAL
...>   FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
...>  WHERE c.C_MKTSEGMENT = 'BUILDING'
...>  GROUP BY c.C_NAME ORDER BY TOTAL DESC LIMIT 10;

+--------+-------+
| C_NAME | TOTAL |
+--------+-------+
| Alice  | 350   |
| Carol  | 300   |
+--------+-------+
2 row(s) returned.

Executed in 23.33 ms
```

Two details about the prompt. A SQL statement is not executed until you end it with a semicolon; until then the prompt changes to `...>` and keeps buffering lines. **Meta commands are the opposite** — they start with `.`, take no semicolon, and run immediately.

| Command | Effect |
|---|---|
| `.tables` | list loaded tables with row counts and columns |
| `.status` | show whether WASM, parallel, and distributed modes are on |
| `.explain <sql>` | print the optimized logical plan |
| `.help` | list the meta commands |
| `exit` / `quit` | leave |

`.explain` gives you a compact tree, rendered by [`planToString`](../../src/planner/logical-plan.ts):

```
sql> .explain SELECT c.C_NAME, SUM(o.O_TOTALPRICE) AS TOTAL FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY WHERE c.C_MKTSEGMENT = 'BUILDING' GROUP BY c.C_NAME ORDER BY TOTAL DESC LIMIT 10

Project
  TopN(10)
    Aggregate
      Join(INNER)
        Filter
          Scan(CUSTOMER AS C)
        Scan(ORDERS AS O)
```

Compare that to running `EXPLAIN` as SQL — with a semicolon, through the normal query path — which uses a different formatter, shows the conditions inside each node, and appends the physical plan underneath. Both print the same optimized logical plan; they differ only in how much they tell you about it. When you want to know *what* the optimizer decided, `.explain` is enough. When you want to know *why*, you want the full `EXPLAIN`, and eventually the visualizer.

### Flags worth knowing

```bash
npm start -- --no-wasm customer.csv      # disable the WebAssembly kernels
npm start -- --parallel customer.csv     # enable worker-thread parallelism
npm start -- --distributed customer.csv  # spawn a local cluster
npm start -- --help
```

Note that first line, because it reveals something the library does not tell you: **the CLI turns WASM on by default and the library does not.** The CLI calls [`enableWasm`](../../src/engine/query-engine.ts) during startup, which loads `core.wasm` and registers 37 kernels. A `QueryEngine` you construct yourself starts with `wasmEnabled` false and zero kernels registered until you call it. Chapter 54 comes back to what those kernels do and do not affect.

Now the second and third lines, because they do **not** work through `npm start`, and the way they fail is misleading:

```
[wasm] WebAssembly acceleration enabled
[parallel] Could not enable parallel execution (WASM required)
```

WebAssembly is enabled — the line above says so. The real cause is that `npm start` runs `dist/index.cli.js`, the bundled build, and both worker pools locate their worker script beside their own module. In the bundle that resolves to `dist/worker-thread.js`, which does not exist; in the per-file build it resolves to `dist/parallel/worker-thread.js`, which does.

So the flags work from the per-file output, which has no entry point of its own — `dist/cli/index.js` exports `start` and never calls it, so running it directly does nothing at all. Write the three lines the bundle's entry stub writes for you:

```javascript
// run-cli.mjs
import './dist/index.js';
import { start } from './dist/cli/index.js';
start();
```

```bash
node run-cli.mjs --parallel customer.csv
```

```
[wasm] WebAssembly acceleration enabled
[parallel] Parallel execution enabled (11 workers)
```

Check `.status` rather than the startup line, and treat "WASM required" as "something went wrong starting the workers" — [`enableParallel`](../../src/engine/query-engine.ts) swallows the real error and the CLI guesses at the cause. [Chapter 46](../06-scale/46-workers-and-shared-memory.md) traces it in full. Everything in Parts 1 through 5 is single-threaded and unaffected by any of this.

## The library

For everything in this book that inspects an intermediate stage, use the library directly. After `npm run build:ts`:

```javascript
import { createEngine, registerTable } from './dist/engine-entry.js';
import './dist/index.js';

const engine = createEngine();
registerTable(engine, 'CUSTOMER', [
  { C_CUSTKEY: 1, C_NAME: 'Alice', C_MKTSEGMENT: 'BUILDING' },
  { C_CUSTKEY: 2, C_NAME: 'Bob', C_MKTSEGMENT: 'MACHINERY' },
  { C_CUSTKEY: 3, C_NAME: 'Carol', C_MKTSEGMENT: 'BUILDING' },
]);

const result = await engine.run('SELECT * FROM CUSTOMER');
console.log(result.rows);
engine.close();
```

The second import is not decorative. [`src/index.ts`](../../src/index.ts) is where the Node build registers its storage backend and its WASM byte source through [`setDefaultStorageBackend`](../../src/engine/query-engine.ts); without it, `createEngine` has no backend and throws. That indirection is what lets the same core run in a browser, and chapter 44 is about why it is built that way.

[`registerTable`](../../src/engine-entry.ts) infers a schema from the rows you hand it, or takes one explicitly as a fourth argument.

The reason to prefer the library is that the compiler stages are exposed individually:

```javascript
const ast = engine.parseSQL(sql);          // parser
const bound = engine.bind(ast);            // binder
const plan = engine.plan(bound);           // logical planner
const optimized = engine.optimize(plan);   // optimizer
```

You can stop anywhere and print what you have. Chapters throughout this book do exactly that, and the most useful variant is watching the optimizer work one pass at a time:

```javascript
const { formatPlan } = await import('./dist/planner/plan-formatter.js');

engine.optimizer.optimize(plan, {}, (event) => {
  const before = formatPlan(event.before);
  const after = formatPlan(event.after);
  if (before !== after) {
    console.log(`--- ${event.pass} ---\n${after}`);
  }
});
```

That third argument is an observer, called after every pass with the plan before and after it. It fires once per pass per iteration — some passes are grouped into a stage that reruns until the plan stops changing, which [chapter 15](../03-optimizer/15-passes-and-fixpoints.md) calls a **fixpoint** — so the count is 27 for this query rather than 24. Filtering to the passes that actually changed something turns those 27 events into the three that mattered. Keep this snippet — it is the single most useful debugging tool in the repository, and Part 3 leans on it constantly.

## The visualizer

```bash
npm run viz
```

That starts a Vite dev server for the React app in [`tools/visualizer/`](../../tools/visualizer/src/App.tsx). It is the same engine compiled to run in the browser, wrapped in an interface that shows the plan as a graph, lists the optimizer passes, and lets you step through them watching nodes move. It also carries short written notes on each pass in [`tools/visualizer/src/content/pass-notes.ts`](../../tools/visualizer/src/content/pass-notes.ts).

When a chapter in Part 3 describes a rewrite, the fastest way to believe it is to type a triggering query into the visualizer and watch the tree change shape.

## The tests

```bash
npm test              # build, then everything
npm run test:unit     # unit tests only
npm run test:e2e      # end-to-end tests only
```

There are 190 test files under `tests/`, and the directory structure mirrors `src/` one-to-one: `tests/optimizer/passes/` holds a file per optimizer pass, `tests/execution/operators/` a file per operator. When you want to know how a component is meant to behave, its test file is often a better specification than its implementation.

`tests/e2e/` is different in kind. Those tests run whole queries and compare answers against a reference implementation — differential testing, which chapter 52 is entirely about. They are the tests that catch an optimizer pass that produces a plausible-looking plan and the wrong answer.

## In the code

| Thing | Where |
|---|---|
| CLI entry and flags | [`start`](../../src/cli/index.ts) |
| REPL loop and meta commands | [`startREPL`](../../src/cli/repl.ts) |
| CSV and JSON loading | [`src/cli/loaders/`](../../src/cli/loaders/loader-factory.ts) |
| Library convenience API | [`createEngine`](../../src/engine-entry.ts) |
| Node platform wiring | [`src/index.ts`](../../src/index.ts) |
| Bundle build | [`scripts/build.js`](../../scripts/build.js) |
| Test configuration | [`vitest.config.ts`](../../vitest.config.ts) |
| Visualizer | [`tools/visualizer/`](../../tools/visualizer/src/App.tsx) |

## Traps

**`npm run build:ts` does not rebuild the CLI.** Covered above, and worth repeating because the failure mode is silent: your change compiles, the CLI runs, and nothing is different.

**The test suite runs against `dist/`, not `src/`.** [`vitest.config.ts`](../../vitest.config.ts) installs a resolver plugin that rewrites every import of a `src/` path to the matching `dist/` path. That is why `npm test` builds first, and why running `vitest` directly after editing source will test the previous build.

**A statement without a semicolon never runs.** The REPL buffers until it sees one. If the prompt is showing `...>`, it is still waiting for you.

**`npm start -- --parallel` and `--distributed` are silently inert.** Covered above. The startup line blames WASM, which is not the cause, and the query still returns correct answers — on one thread.

**Row counts in `.tables` are real, not estimates.** They come from the loaded storage. The **cardinality** numbers the optimizer reasons about — its guesses at how many rows each step of a plan will produce — are a different thing entirely, gathered separately, and frequently wrong. Part 3 depends on that distinction, and [chapter 23](../03-optimizer/23-cardinality-estimation.md) is about where the guesses come from.

## Exercises

1. Build with `npm run build`, load the two CSVs from this chapter, and reproduce the transcript above. Confirm you get `Alice 350` and `Carol 300`.

2. Run the same query through `.explain` and through SQL `EXPLAIN`. Write down what the second one tells you that the first does not.

3. Use the observer snippet to list every pass that changed the plan for the running query. You should see three. Add a `LEFT JOIN` and see whether the list changes.

4. Edit [`plan-formatter.ts`](../../src/planner/plan-formatter.ts) to print something visibly different — an exclamation mark after each node name. Run `npm run build:ts` and start the CLI. Does your change appear? Now run `npm run build` and try again. Explain the difference.

5. Start the engine without importing `./dist/index.js` and read the error. Which line in [`query-engine.ts`](../../src/engine/query-engine.ts) produced it, and what is it protecting?

## Recap

- `npm run build` refreshes everything; `npm run build:ts` is faster but leaves the **CLI and browser bundles stale**. That distinction is the most common source of wasted time in this repository.
- The **REPL** takes CSV and JSON files, names tables after them, needs a semicolon to run a statement, and offers `.tables`, `.status`, and `.explain`.
- `--parallel` and `--distributed` **do nothing through `npm start`**, because the bundle cannot find its worker scripts, and the error message names the wrong cause. Nothing before Part 6 depends on them.
- The **library** exposes `parseSQL`, `bind`, `plan`, and `optimize` separately, so you can print any intermediate stage. The **observer** argument to `optimize` shows the plan after each pass.
- The **visualizer** (`npm run viz`) is the same engine in a browser with a graph view and per-pass notes.
- Tests run against `dist/`, mirror `src/` one-to-one, and split into unit and end-to-end suites.
- The CLI enables WASM by default; the library does not.

Next: [chapter 3](03-map-of-the-codebase.md) walks the source tree, so that when a later chapter says "this happens in the binder", you know where to look and what else lives nearby.
