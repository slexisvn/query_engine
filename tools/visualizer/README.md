# Optimizer Visualizer

A teaching tool for the query engine. Type SQL, watch it become a plan, step through the optimizer
one pass at a time — with the plan tree **animating** from its shape before the pass to its shape
after it — then run the query on your own CSV and see the rows it produces.

```bash
npm --prefix tools/visualizer install
npm run viz
```

Then open the URL Vite prints. Nothing is bundled ahead of time: Vite serves the engine straight
from `src/*.ts`, so an edit to a pass shows up on reload.

## What it shows

The stage rail across the top of the middle column follows the real compile path:

| stage | what you see |
| --- | --- |
| Parse | the AST the parser produced |
| Bind | the bound query, names resolved against the catalog |
| Plan | the unoptimized logical plan |
| Optimize | every pass run, with before/after and a morph between them |
| Physical | the operators the physical planner chose |
| Results | the rows the query actually computed |

The rail splits those into two labelled groups — **planning**, which never touches a row, and
**running**, which does. The Tree/Text switch sits apart on the right under its own **view** label,
because choosing how to draw a plan is a different kind of choice from choosing which stage to look
at, and the two should not look like one row of seven identical tabs.

Plan and Optimize each offer two views. **Tree** is the animated canvas. **Text** is a unified diff of
`formatPlan` output, read like a git diff: `-` for operators the pass consumed, `+` for ones it
produced, and `~` for lines that only changed depth. That last marker matters — removing one operator
re-indents everything beneath it, and without separating the two a two-node fusion would read as six
removals and five additions instead of `−2 +1 ~4`.

Your query and row counts are kept in local storage, so a reload brings them back. Nothing is written
to the URL.

Under **Optimize**, each row is one pass run. Rows carry the node-count delta and the estimated cost
delta; passes that changed nothing are hidden until you untick *only changes*. The
`PredicateOptimization` stage is a fixpoint, so it appears once per iteration — which is the point of
that stage.

## Reading the animation

Selecting a pass plays its transformation. Node colour tells you what the diff decided:

- **blue, moving** — the same node in a new position (`PredicatePushdown` sliding a filter below a join)
- **amber** — the node stayed put but its contents changed (`ExpressionSimplifier` dropping `1 = 1`)
- **red, shrinking** — removed (the `Sort` and `Limit` that `TopNFusion` consumes)
- **green, growing** — added, entering where the node it replaced stood (the fused `Top-N`)

Removed nodes leave first, survivors travel, new nodes arrive last, so the three things never
overlap. Drag the scrub bar to hold the plan halfway through a rewrite — the render is a pure
function of the transition position, not a CSS animation you have to catch in flight.

Controls: `←`/`→` step between passes, `Space` plays through every pass that changed something, `R`
replays the current one. The speed selector runs from 0.25× to 4× — quarter speed is the one to reach
for when a rewrite moves several nodes at once. *spotlight* dims the nodes the pass did not touch.
With the operating system's reduce-motion setting on, transitions cut straight to the result.

On the canvas: drag to pan, wheel or pinch to zoom, `fit` (or a double-click) to reset. Wheel and
pinch both zoom about the pointer — the operator under the cursor or between your fingers stays put,
so you can magnify one corner of a wide plan without chasing it back into view. The `‹` button in the
top-left corner folds the query and catalog away when you want the plan to fill the screen.

## Node sizing

Nodes are never truncated — a node is measured from its own text and grows to fit, wrapping long
expressions across lines and taking the row estimate on its title line. Sibling spacing comes from
the measured widths, so a wide `Filter` pushes its neighbours apart instead of overlapping them. The
width and height are interpolated during a morph too, so a node whose predicate shrinks visibly
narrows as the text changes.

## Cost per pass

There is no separate cost chart — the numbers live on the pass rows you are already reading. Each row
that rewrote the plan carries its node delta, its cost delta as a percentage, and a bar that runs out
from a centre line: green to the left for a saving, red to the right for an increase, grey astride
the line for a rewrite the cost model prices the same. Bar length is the **absolute** change scaled
against the largest one in the run, which is the part a percentage hides — on the bundled pushdown
example `PredicatePushdown` at −34% saves roughly twice what `TopNFusion` at −25% does. Hovering a row
gives the absolute before and after; the list header carries the endpoints and the overall move.

Grey bars are worth pausing on when teaching: `ProjectionPushdown` and `ScanPruning` both change the
plan, but this cost model prices a scan by row count rather than row width, so they read as 0%. The
change is still visible — a scan node carries the columns it reads, so pruning shows up as the node
losing columns and narrowing — it just does not move the estimate. That is a limit of the model, not
of the pass.

## Data and statistics

The catalog holds one thing at a time: **your data if you have any, the sample schema otherwise.**
There is no mode switch and the two never sit side by side, because a catalog listing eight tables
you cannot query next to two you can is just confusing.

**Sample schema** — the state you start in — is TPC-H: column definitions, indexes on the primary
keys plus `O_ORDERDATE` and `L_SHIPDATE`, and *estimated* statistics with no rows behind them. Row
counts are editable and every derived statistic rescales with them, which is the fastest way to show
that cost-based passes are decisions rather than rules: raise `NATION` on the *Join reorder* example
and the optimizer moves it to the other end of the join tree. The bundled examples all query these
tables, so the example picker lives here too.

**Your data** takes over the moment a CSV lands — button or drag-and-drop onto the catalog panel. The
sample tables are dropped from the catalog, the example picker goes away with them, and the file name
becomes the table name. Column types are inferred by the engine's own `inferColumnType`, statistics
come from `collectStatistics` over the real rows, and clicking a table opens a paged preview of what
was loaded, 25 rows a page, so you can check a file parsed the way you expected before writing a
query. Previews keep the first 1,000 rows and the pager reports the file's real size beside them.

Remove the last import and the sample schema comes back, indexes and estimates intact.

Two things worth knowing about import:

- A date column stays **text**. Turning `2024-03-15` into a temporal value made the engine compare
  epoch-days against epoch-milliseconds and answer `WHERE sold_on > '2024-02-01'` with zero rows —
  silently wrong. As text, ISO dates compare and sort correctly against ordinary string literals.
- A CSV carries no keys or indexes, so an imported table has neither. `JoinElimination` and
  `DistinctElimination` both need to prove uniqueness, so they only ever fire on the sample schema.
- Imported rows live in memory for the session. Reload and the table is gone, though the query text
  and your row-count edits come back.

## Running a query

**Run** (or `Ctrl/⌘+Enter`) drives the entire tool. Nothing on the right recomputes on its own —
not when you type, not when you pick an example, not when you import a CSV. One press does parse,
bind, plan, all 27 optimizer passes, physical planning, and execution.

That gives the page a single rule worth stating out loud: **the left column is what you are about to
run, the right column is what you last ran.** Edit SQL, swap examples, import a file, change a row
count — the left side follows you immediately while the right side holds still, so the plan you are
studying never silently becomes a plan for different SQL. When the two drift apart the Run button
fills in and the header reads `out of date — press Run`.

Run does not steal the stage you are on. The badges on the rail update in place, so you can sit on
Optimize, edit, re-run, and watch the pass list change without being thrown into Results.

Running against the sample schema is reported as a failure rather than smoothed over: `No rows to run
against`, `CUSTOMER is defined but empty`, and a red badge on the rail so you see it without leaving
the stage you are on. The message says where to fix it — the Catalog panel — and stops there; an
error is not the place for a button that teleports you somewhere else.

Results arrive paged, 100 rows at a time, with the total and the wall time of the run in the header.
Numeric columns right-align, nulls dim out, and a run is held to 5,000 rows — past that the pager
says how many the query really produced.

## Sample data

`sample-sales.csv` (2000 rows), `sample-regions.csv` (8 rows) and `sample-queries.sql` sit at the
repository root. Import the two CSVs through the catalog panel and work through the queries — each is
annotated with the passes it actually fires, measured against those files. Delete all three when you
are done: `rm sample-*.csv sample-queries.sql`.

## CTEs

A `WITH` clause is not inlined into the main plan — the planner keeps each CTE body as its own plan.
The visualizer follows that: a query with CTEs gets a subject picker, and each body carries its own
pass trace, cost, and physical plan.

## Narrow screens

Below 1000px the three columns cannot all be useful at once, so the tool switches to **one pane at a
time** and grows a rail along the bottom: **Query**, **Passes**, **Stages**. All three panes stay
mounted — switching keeps your cursor in the editor, the schema rows you expanded, and the plan you
had panned into place.

The rail carries the two things you would otherwise have to switch panes to read: how many passes
changed the plan, and which stage the Stages pane is holding. The two moves that would otherwise
strand you on a dead pane bring the answer with them — tapping a pass jumps to the plan it rewrote,
and pressing Run from the Query pane jumps to the stage that just recomputed. Run still does not
steal your *stage*: come back from Passes and you are on Optimize where you left it.

What the top bar drops on the way down is the example blurb and the table/row summary — the Run
button already says `out of date` by filling in, and the catalog is one tap away. The example picker
takes a row of its own unless the window is too short to spare one, in which case it goes back
inline.

The stage rail keeps both labelled groups and both badges: it wraps to a second row rather than
scrolling, and only the planning group scrolls sideways, and only below about 340px. Text inputs are
16px on a compact viewport, which is what stops iOS zooming the whole page when you tap into the
editor.

## Deploying

`.github/workflows/deploy-visualizer.yml` publishes the tool to GitHub Pages on every push to `main`
that touches the engine or the visualizer, and on demand from the Actions tab. It typechecks and runs
the suites before it builds — a broken pass note or a pass that stopped changing the plan fails the
deploy rather than shipping.

One thing needs doing by hand, once: set **Settings → Pages → Source** to **GitHub Actions**.
Without it the deploy job has nothing to publish to. The site then lands at
`https://<owner>.github.io/<repo>/`.

The build reads its base path from `VIZ_BASE`, which the workflow sets to the repository name — a
project site is served from a subdirectory, and a bundle built for `/` would ask for its assets at
the domain root and get a blank page. `npm run build` with no `VIZ_BASE` builds for `/`, which is
what you want for a user site (`<owner>.github.io`) or a custom domain.

To check the production bundle locally before pushing:

```bash
npm --prefix tools/visualizer run build && npm --prefix tools/visualizer run preview
```

## Layout

```
src/engine/    csv → workspace → compile → trace → diff → morph, all unit tested
src/ui/        React components, one concern each
src/content/   the teaching copy and the bundled examples
tests/         mirrors src/
```

`workspace.ts` owns the single `QueryEngine` and its catalog, so the tables you import are visible to
both the planner and the executor. It runs on `MemoryStorageBackend` with no WASM — `vite.config.ts`
stubs the `parallel` and `distributed` subsystems exactly the way `scripts/build.js` does for the
engine's own browser bundle.

The optimizer is traced through an observer hook on `Optimizer.optimize`
(`src/optimizer/optimizer.ts`), so fixpoint semantics stay defined in exactly one place. Node labels
come from `formatNode` in `src/planner/plan-formatter.ts` and costs from the real
`PhysicalPlanner` — the visualizer computes no estimates of its own.

```bash
npm --prefix tools/visualizer test        # engine, diff, example and visibility tests
npm --prefix tools/visualizer run typecheck
```

Two suites keep the teaching honest.

`examples.test.ts` asserts that each bundled query really does fire the passes it claims to teach, and
that every pass in the pipeline has a note. Add a pass to `createDefaultOptimizer` without documenting
it and the suite fails.

`pass-visibility.test.ts` enforces the rule this tool lives or dies by: **if a pass changed the plan,
the rendered plan must change too.** It traces a battery of queries and fails on any step where
`planSignature` moved but the rendered text did not. Passes no SQL in the suite reaches — `NodeMerge`,
`PredicateDedup`, `CTEOptimization` — are checked by building the plan directly and applying the
pass. `PlanProperties` is exempt and asserted to be exempt: it writes only underscore
-prefixed annotations, which `planSignature` ignores, so it never registers as a rewrite at all. A
final case fails if any registered pass is missing from that accounting.

The rule earned its keep. Column pruning and block pruning both change fields *inside* a Scan node
rather than the shape of the tree, so both once fired while the plan on screen sat perfectly still.

`AggregatePushdown` is the cautionary tale. Its aggregates once rendered as `undefined(...)` because
the pass wrote `func` where the formatter read `name` — and `name` is what the binder emits, so the
pass never matched a real query at all. Only its own hand-built fixture, which set `func`, ever
reached it, and listing it as a directly-checked pass is what let that hide. It is now driven from
real SQL in `SQL_REACHABLE` instead. When a pass can only be demonstrated on a plan the binder
cannot produce, that is the finding, not a gap in the corpus.
