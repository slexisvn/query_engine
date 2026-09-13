# 15. Passes and fixpoints

> After this chapter you will be able to add, remove, and reorder optimizer passes, and explain a query on which the optimizer's fixpoint loop never converges and stops only because it runs out of iterations.

## The question

Set `QE_OPTIMIZER_FIXPOINT_ITERATIONS` to 32 instead of its default of 8 and re-optimize this query:

```sql
SELECT c.C_NAME
FROM CUSTOMER c
JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
WHERE n.N_NATIONKEY = 3
```

The plan gets *bigger*. Run the predicate stage on its own at several iteration limits and count how many times the predicate `(C.C_NATIONKEY = 3)` appears in the result:

```
maxIterations=1:  copies of (C.C_NATIONKEY = 3) = 1
maxIterations=2:  copies of (C.C_NATIONKEY = 3) = 2
maxIterations=4:  copies of (C.C_NATIONKEY = 3) = 4
maxIterations=8:  copies of (C.C_NATIONKEY = 3) = 8
maxIterations=16: copies of (C.C_NATIONKEY = 3) = 16
maxIterations=32: copies of (C.C_NATIONKEY = 3) = 32
```

Exactly one copy per iteration, forever. A loop named "run to fixpoint" that has no fixpoint, on a five-line query. By the end of this chapter you will know which two passes are feeding each other, why the loop terminates anyway, and which later pass quietly cleans up after it.

## A fixpoint on a small expression

Before the multi-pass experiment, imagine a simplifier rewriting `((2 + 3) * x) + 0`. One sweep could fold `2 + 3` to 5, producing `(5 * x) + 0`; another could remove `+ 0`, producing `5 * x`. A further sweep makes no change. That last sweep establishes a fixpoint for this rule set. This is a hand-worked illustration, not the exact sweep count of the engine's expression simplifier.

## A pass is one method

[`OptimizationPass`](../../src/optimizer/pass.ts) is nine lines:

```typescript
export abstract class OptimizationPass {
  abstract get name(): string;
  abstract apply(plan: LogicalPlanNode, context?: OptimizationContext): LogicalPlanNode;
}
```

A name and a plan-to-plan function. There is no declared precondition, no cost estimate, no way for a pass to say "I did nothing" — the driver works that out by comparing plans. `OptimizationContext` carries a single flag, `rootOrderRequired`, which only [`SortElimination`](../../src/optimizer/passes/sort-elimination.ts) reads.

Almost every pass implements `apply` by delegating to a subclass of [`PlanRewriter`](../../src/planner/plan-rewriter.ts), which walks the tree bottom-up and dispatches on node type. That is why a pass file typically contains a two-line pass class and a hundred-line rewriter class.

## Two ways to register

[`Optimizer`](../../src/optimizer/optimizer.ts) holds an array of **stages**, not an array of passes:

```typescript
export interface OptimizerStage {
  name: string;
  passes: OptimizationPass[];
  maxIterations: number;
}
```

[`registerPass`](../../src/optimizer/optimizer.ts) wraps a single pass in a stage with `maxIterations: 1`. [`registerFixpoint`](../../src/optimizer/optimizer.ts) takes a group of passes and a name, and defaults `maxIterations` to `Config.optimizerFixpointIterations`, which is 8.

[`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) uses exactly one fixpoint stage:

```typescript
.registerFixpoint(PREDICATE_FIXPOINT_STAGE, [
  new PredicatePushdown(),
  new PredicateInference(),
  new OuterToInnerJoin(),
])
```

Everything else is a `registerPass`. That is why the two listing methods disagree:

```javascript
engine.optimizer.listPasses().length    // 24
engine.optimizer.listStages().length    // 22
```

Twenty-two stages; one of them contains three passes, and `PredicatePushdown` is registered a second time as its own stage after `JoinReorder`.

## What the driver does

[`optimize`](../../src/optimizer/optimizer.ts) is a fold over the stages:

```typescript
for (const stage of this.stages) {
  current = stage.maxIterations <= 1
    ? this.runOnce(stage, current, context, 0, observer)
    : this.runToFixpoint(stage, current, context, observer);
}
```

[`runOnce`](../../src/optimizer/optimizer.ts) applies each pass in the stage in order and calls the observer after each with `before` and `after`. [`runToFixpoint`](../../src/optimizer/optimizer.ts) wraps `runOnce` in a loop:

```typescript
let signature = planSignature(current);

for (let iteration = 0; iteration < stage.maxIterations; iteration++) {
  current = this.runOnce(stage, current, context, iteration, observer);
  const nextSignature = planSignature(current);
  if (nextSignature === signature) break;
  signature = nextSignature;
}
```

Note the shape. The stage always runs at least once. It runs a second time only if the first sweep changed something, and it stops as soon as a whole sweep leaves the plan alone. So a productive stage costs one wasted sweep to prove it has finished, which for the book's running query means two iterations of three passes for one useful rewrite.

## Comparing plans by value

The loop's exit condition needs an equality test on plans, and the plans are ordinary JavaScript objects rebuilt fresh by every rewriter — reference equality would never hold. [`planSignature`](../../src/optimizer/plan-signature.ts) is the whole answer:

```typescript
const INTERNAL_FIELD_PREFIX = '_';

function stableValue(key: string, value: unknown): unknown {
  if (key.startsWith(INTERNAL_FIELD_PREFIX)) return undefined;
  if (typeof value === 'bigint') return `${value}n`;
  return value;
}

export function planSignature(plan: LogicalPlanNode): string {
  return JSON.stringify(plan, stableValue);
}
```

`JSON.stringify` with a replacer. Two decisions are packed into those three lines.

**BigInt values are stringified** because `JSON.stringify` throws on them, and `INT64` literals are BigInts.

**Fields whose name begins with `_` are dropped.** This is the load-bearing one. Several passes annotate nodes rather than restructure them: [`PlanProperties`](../../src/optimizer/passes/plan-properties.ts) attaches `_cardinality` and `_sortedBy`, `LimitPushdown` attaches `_limitHint`, and the planner attaches `_cteMap`. Underscore-prefixed fields are invisible to the signature, so an annotation is not a change:

```javascript
planSignature(plan) === planSignature({ ...plan, _cardinality: 200 })   // true
```

Without that rule, an annotating pass inside a fixpoint stage would report a change every single sweep and the loop would always burn all eight iterations. The convention is not documentation — it is the termination condition.

## The query that will not converge

Now the opening question. Run only the predicate stage and watch it.

Iteration 0 begins with the filter above both joins:

```
-> Project (C.C_NAME)
  -> Filter (condition: (N.N_NATIONKEY = 3))
    -> Join (condition: (C.C_NATIONKEY = N.N_NATIONKEY))
      -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
        -> Seq Scan on CUSTOMER as C
        -> Seq Scan on ORDERS as O
      -> Seq Scan on NATION as N
```

`PredicatePushdown` moves `N.N_NATIONKEY = 3` into the right input of the upper join. Then `PredicateInference` looks at that join, sees the equality `C.C_NATIONKEY = N.N_NATIONKEY` in the condition and the constant `N.N_NATIONKEY = 3` in the filter directly beneath the right side, and manufactures `C.C_NATIONKEY = 3` for the left side:

```
-> Project (C.C_NAME)
  -> Join (condition: (C.C_NATIONKEY = N.N_NATIONKEY))
    -> Filter (condition: (C.C_NATIONKEY = 3))
      -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
        -> Seq Scan on CUSTOMER as C
        -> Seq Scan on ORDERS as O
    -> Filter (condition: (N.N_NATIONKEY = 3))
      -> Seq Scan on NATION as N
```

The plan changed, so iteration 1 runs. `PredicatePushdown` pushes the new filter down past the lower join onto the `CUSTOMER` scan — which removes it from the position where inference had put it. `PredicateInference` then looks at the upper join again, finds the same equality and the same constant, checks whether the predicate already exists, and asks the wrong question:

```typescript
function collectFiltersAbove(node: LogicalPlanNode, preds: BoundExpr[]): void {
  if (!node) return;
  if (node.type === PlanNodeType.FILTER) {
    preds.push(...splitConjuncts(node.condition));
  }
}
```

It inspects the join's **immediate child**, and only if that child is a `Filter`. After pushdown the immediate child is a `Join`, so the existing copy of `C.C_NATIONKEY = 3` — now two levels down on the scan — is invisible. Inference concludes the predicate is missing and adds it again. Iteration 2 pushes that copy down onto the scan, where it lands next to the first, and inference adds a third.

At `maxIterations = 8`, the predicate stage stops mid-cycle with this:

```
-> Project (C.C_NAME)
  -> Join (condition: (C.C_NATIONKEY = N.N_NATIONKEY))
    -> Filter (condition: (C.C_NATIONKEY = 3))
      -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
        -> Filter (condition: (((((((C.C_NATIONKEY = 3) AND (C.C_NATIONKEY = 3)) AND (C.C_NATIONKEY = 3)) AND (C.C_NATIONKEY = 3)) AND (C.C_NATIONKEY = 3)) AND (C.C_NATIONKEY = 3)) AND (C.C_NATIONKEY = 3)))
          -> Seq Scan on CUSTOMER as C
        -> Seq Scan on ORDERS as O
    -> Filter (condition: (N.N_NATIONKEY = 3))
      -> Seq Scan on NATION as N
```

So `maxIterations` is not a safety net for a loop that normally converges. On this query it is the *only* reason optimization terminates.

## Why nobody notices

Run the same query through the full default pipeline and the output is clean:

```
-> Project (C.C_NAME)
  -> Join (condition: (C.C_CUSTKEY = O.O_CUSTKEY))
    -> Join (condition: (C.C_NATIONKEY = N.N_NATIONKEY))
      -> Filter (condition: (C.C_NATIONKEY = 3))
        -> Seq Scan on CUSTOMER as C
      -> Filter (condition: (N.N_NATIONKEY = 3))
        -> Seq Scan on NATION as N
    -> Seq Scan on ORDERS as O
```

One copy. [`PredicateDedup`](../../src/optimizer/passes/predicate-dedup.ts) runs ten stages later and collapses conjuncts with equal expression keys, and the eight duplicates become one. [Chapter 19](19-projection-limit-and-cleanup.md) covers that pass, which reads like a tidying-up chore until you know what it is tidying up after.

This is a pattern worth naming. The pipeline tolerates passes that generate garbage because a later pass collects it, which lets each pass stay simple at the cost of making any single pass's output misleading in isolation. It also means the bound is real: eight iterations of a divergent loop cost eight redundant conjuncts, and the cost is linear rather than exponential precisely because the duplicates are conjuncts of one filter rather than new nodes.

## Editing the pipeline

Four methods let you change the pipeline at runtime, which is how every ablation experiment in this part is performed:

| Method | Effect |
|---|---|
| [`registerPass`](../../src/optimizer/optimizer.ts) | append a single-pass stage |
| [`registerFixpoint`](../../src/optimizer/optimizer.ts) | append a looping stage |
| [`removePass`](../../src/optimizer/optimizer.ts) | drop a pass by name from every stage, deleting stages left empty |
| [`insertPassBefore`](../../src/optimizer/optimizer.ts) / [`insertPassAfter`](../../src/optimizer/optimizer.ts) | splice a new stage relative to the stage containing a named pass |

`removePass` removes *every* registration of a name. Removing `PredicatePushdown` removes both the one inside the fixpoint and the one after `JoinReorder`; there is no way to drop only one of them through this API.

Note also that these methods mutate the `Optimizer` object, and `QueryEngine` replaces that object the first time it collects statistics. That interaction silently undoes ablation experiments and is the subject of a warning in [chapter 28](28-plan-properties-and-ablation.md).

## The observer

Every pass invocation calls the observer, if one was supplied:

```typescript
observer?.({ stage: stage.name, pass: pass.name, iteration, before, after: current });
```

For the book's running query that is **27 events** — 24 registrations plus the extra sweep of the three-pass fixpoint. Three of them change the plan as `formatPlan` prints it. Compare with `planSignature` instead and it is five, because two of the passes change things the formatter does not print. Chapter 19 says which two.

## In the code

| Idea | Where |
|---|---|
| Pass interface | [`OptimizationPass`](../../src/optimizer/pass.ts) |
| Stage list and driver | [`Optimizer`](../../src/optimizer/optimizer.ts) |
| Single-pass registration | [`registerPass`](../../src/optimizer/optimizer.ts) |
| Looping registration | [`registerFixpoint`](../../src/optimizer/optimizer.ts) |
| The loop | [`runToFixpoint`](../../src/optimizer/optimizer.ts) |
| One sweep | [`runOnce`](../../src/optimizer/optimizer.ts) |
| Plan equality | [`planSignature`](../../src/optimizer/plan-signature.ts) |
| The 24 registrations | [`createDefaultOptimizer`](../../src/optimizer/optimizer-pipeline.ts) |
| Tree walking base class | [`PlanRewriter`](../../src/planner/plan-rewriter.ts) |
| Iteration limit | `optimizerFixpointIterations` in [`Config`](../../src/config.ts) |

## Traps

**A stage that changes nothing still runs twice as often as you would guess for one that changes something.** The fixpoint costs one confirming sweep. On the running query that is three extra pass invocations for zero benefit — cheap, but it is why the observer fires 27 times for a 24-pass pipeline.

**`planSignature` is `JSON.stringify`, so key order matters.** A rewriter that rebuilds a node with `{ condition, ...node }` instead of `{ ...node, condition }` produces a different signature for an identical plan, and the fixpoint would loop until the cap. No pass does this today; nothing prevents one from starting.

**The `_` prefix is API.** Naming an annotation field without the underscore makes it part of plan identity. Naming a structural field *with* one makes a real change invisible to the loop.

**Pass order in `createDefaultOptimizer` is not arbitrary and is not documented in the file.** `IndexSelection` must run after the predicates have reached the scans; `TopNFusion` must run after `LimitPushdown` has moved the `Limit` next to the `Sort`. Reordering the list compiles and passes most tests.

## Recap

- A pass is a **name plus a plan-to-plan function**; the driver, not the pass, decides whether anything changed.
- The optimizer holds **stages**. `registerPass` makes a stage of one pass that runs once; `registerFixpoint` makes a stage that reruns its group until the plan stops changing, capped at `optimizerFixpointIterations` (8).
- Plan equality is [`planSignature`](../../src/optimizer/plan-signature.ts), a `JSON.stringify` that **drops every field starting with `_`**. That convention is what stops annotating passes from spinning the loop forever.
- A three-table query with a constant on one join key makes the predicate fixpoint **diverge**: inference re-derives a predicate that pushdown has already moved out of its field of view, one fresh copy per iteration. The iteration cap is what terminates it, and `PredicateDedup` is what hides it.
- Passes are cheap to add, remove, and reorder at runtime, which is how the ablation experiments throughout Part 3 are done.

Next: [chapter 16](16-expression-simplification.md) starts on the passes themselves, with the one that runs first and unlocks work for the one after it.
