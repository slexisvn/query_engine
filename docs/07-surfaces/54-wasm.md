# 54. WASM: loading a kernel and reaching it

> After this chapter you will be able to distinguish a compiled kernel, a registered kernel, and an actual kernel invocation, and measure which of those a query reaches.

## The question

The CLI prints that WebAssembly acceleration is enabled. Does `SELECT A * 2 FROM T` therefore run in WebAssembly? It depends on the expression, types, chunk size, and execution path. A loaded implementation is only one of the conditions.

Run this example from the repository root:

```bash
npm run build
node docs/examples/wasm.mjs
```

The script verifies a 5,000-row floating-point projection, counts calls to its multiply kernel, and then calls that kernel directly on `[1, 2, 3]`. With the checked-in defaults, the query does not call that kernel, while the direct call returns `[2, 4, 6]`.

## Three separate events

| Event | What it establishes | What it does not establish |
|---|---|---|
| AssemblyScript builds `core.wasm` | compiled code exists on disk | the engine loaded it |
| `enableWasm()` loads and registers kernels | supported operations can be looked up | a query passed their runtime gates |
| a kernel wrapper is invoked | this operation reached the kernel | the whole query became faster |

[`enableWasm`](../../src/engine/query-engine.ts) loads the core module through the configured byte source, calls [`registerAllKernels`](../../src/wasm/register-kernels.ts), and sets `wasmEnabled`. It catches loading failures and reports them, so a resolved call alone is not proof of success: inspect the enabled state or registry too.

The dispatch registry maps operation/type pairs to implementations. For example, `scalarMulF64:FLOAT64` identifies multiplication of a floating-point vector by a scalar. The registry is shared in the module instance; it is not a fresh private table for each engine. The CLI calls `enableWasm` during startup. Library users can call it explicitly.

## Follow the multiplication

Suppose T holds 5,000 `FLOAT64` values. Storage breaks them into chunks of 2,048, 2,048, and 904. For each chunk, the projection considers its execution paths.

`tryWasmProject` first checks whether the expression has a supported arithmetic shape. It then compares the **chunk's** size with `Config.wasmMinChunkSize`. The default is 4,096. None of the three chunks reaches that threshold, even though the table has more than 4,096 rows.

The operator can still use the TypeScript columnar projection path from chapter 31. That processes a whole numeric column with a loop; it does not require WASM. The example therefore returns all the correct doubled values while recording zero calls to the WASM multiply kernel.

The direct call bypasses query selection. It looks up the registered kernel and invokes it with `new Float64Array([1, 2, 3])` and scalar 2. Getting `[2, 4, 6]` demonstrates that the kernel exists and works for this input, while the preceding counter explains why the query did not use it.

This observation concerns the projection path and defaults in this checkout. Derived chunks can have different sizes; environment settings can change the threshold; worker-enabled execution uses additional paths. Do not generalize one counter into a claim that no WASM code can ever run.

## The memory boundary

WASM code operates on its own linear memory. The wrappers in [kernel-factory.ts](../../src/wasm/kernels/kernel-factory.ts) allocate regions, copy or resolve input data, call an exported function with numeric pointers and counts, and read the result back.

That boundary has a cost. A fast arithmetic loop may save less time than moving its input and output consumes. Other wrappers can resolve pointers differently, and shared-memory worker execution introduces separate ownership and allocation considerations. Measure the complete operation rather than timing only an arithmetic instruction loop.

Changing a dispatch threshold also requires correctness checks. SQL null propagation, division by zero, exact integer types, decimal scaling, and selection vectors must agree with the ordinary evaluator. A kernel that computes plausible numbers can still violate the expression's declared type or null semantics.

## In the code

| Purpose | Source |
|---|---|
| module loading and registration | [`enableWasm`](../../src/engine/query-engine.ts) |
| operation registry | [`WasmDispatch`](../../src/wasm/dispatch.ts) |
| registrations | [`registerAllKernels`](../../src/wasm/register-kernels.ts) |
| query size and shape gates | [`tryWasmProject`](../../src/execution/operators/projection.ts) |
| expression-to-kernel dispatch | [`evalVectorized`](../../src/execution/wasm-expr-eval.ts) |
| pointer and buffer wrappers | [kernel-factory.ts](../../src/wasm/kernels/kernel-factory.ts) |
| compiled arithmetic | [arithmetic.ts](../../src/wasm/assembly/arithmetic.ts) |
| runnable invocation counter | [wasm.mjs](../examples/wasm.mjs) |

## Traps

**Table size is not chunk size.** A threshold tested per chunk does not become reachable merely by adding more chunks.

**An enabled flag records setup.** Count an invocation when the question is whether a query used the implementation.

**WASM, batching, SIMD, and threads are separate choices.** None follows automatically from the presence of another. These kernels can run on the calling thread.

**Changing global dispatch affects later work in the same process.** The example restores the wrapped kernel in `finally`. Run independent experiments in fresh processes when comparing initialization behavior.

## Recap

- Compilation, registration, and invocation are different evidence.
- The default chunk-size gate prevents the demonstrated projection from reaching WASM.
- A direct call verifies the kernel separately from the query's dispatch decisions.
- Check semantic equivalence and transfer costs before interpreting an acceleration result.

This completes the book's path from SQL text to execution and its inspection tools. Use the [glossary](../appendix/glossary.md) to revisit terminology, the [SQL guide](../appendix/sql-grammar.md) and [configuration reference](../appendix/configuration.md) for this engine's surface, and [further reading](../appendix/further-reading.md) for the broader designs behind it.
