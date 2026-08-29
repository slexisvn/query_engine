import { createDefaultOptimizer } from '@engine/optimizer/optimizer-pipeline.js';
import { planSignature } from '@engine/optimizer/plan-signature.js';
import { cteScanOrderRequirements } from '@engine/optimizer/passes/sort-elimination.js';
import { compile } from './compile.js';
import { countNodes, PlanMetrics } from './metrics.js';
import type { Catalog } from '@engine/catalog/catalog.js';
import type { TableStats } from '@engine/catalog/statistics.js';
import type { OptimizationContext } from '@engine/optimizer/pass.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';
import type { CompiledQuery, CompileFailure } from './compile.js';

export const MAIN_SUBJECT = 'Main query';

export const NO_PASSES_DISABLED: ReadonlySet<string> = new Set();

export interface PlanSnapshot {
  plan: LogicalPlanNode;
  display: LogicalPlanNode;
  nodes: number;
  cost: number | null;
}

export interface PassStep {
  index: number;
  stage: string;
  pass: string;
  iteration: number;
  changed: boolean;
  ms: number;
  repeats: number | null;
  from: number;
  to: number;
}

export interface OptimizeFailure {
  message: string;
  afterStep: number;
}

export interface OptimizeTrace {
  snapshots: PlanSnapshot[];
  steps: PassStep[];
  error: OptimizeFailure | null;
  totalMs: number;
}

export interface TraceSubject {
  name: string;
  optimize: OptimizeTrace;
  physical: PhysicalPlanNode | null;
}

export interface PipelineTrace {
  sql: string;
  compiled: CompiledQuery;
  metrics: PlanMetrics;
  disabled: ReadonlySet<string>;
  subjects: TraceSubject[];
}

export type TraceOutcome =
  | { ok: true; trace: PipelineTrace }
  | { ok: false; error: CompileFailure };

interface RawEvent {
  stage: string;
  pass: string;
  iteration: number;
  after: LogicalPlanNode;
  changed: boolean;
  ms: number;
  signature: string;
}

interface TraceSetup {
  catalog: Catalog;
  statistics: Map<string, TableStats>;
  metrics: PlanMetrics;
  disabled: ReadonlySet<string>;
}

export interface StageSignature {
  stage: string;
  signature: string;
  changed: boolean;
}

export function repeatsOf(events: readonly StageSignature[]): (number | null)[] {
  const seenByStage = new Map<string, Map<string, number>>();

  return events.map((event, index) => {
    let seen = seenByStage.get(event.stage);
    if (!seen) {
      seen = new Map();
      seenByStage.set(event.stage, seen);
    }
    const earlier = seen.get(event.signature);
    if (earlier === undefined) seen.set(event.signature, index);
    return event.changed && earlier !== undefined ? earlier : null;
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotOf(plan: LogicalPlanNode, metrics: PlanMetrics): PlanSnapshot {
  return { plan, display: metrics.annotate(plan), nodes: countNodes(plan), cost: metrics.cost(plan) };
}

function runOptimizer(logicalPlan: LogicalPlanNode, setup: TraceSetup, context: OptimizationContext): OptimizeTrace {
  const optimizer = createDefaultOptimizer({ catalog: setup.catalog, statistics: setup.statistics });
  for (const name of setup.disabled) optimizer.removePass(name);

  const events: RawEvent[] = [];
  let previousSignature = planSignature(logicalPlan);
  let resumedAt = performance.now();

  let error: OptimizeFailure | null = null;
  try {
    optimizer.optimize(logicalPlan, context, event => {
      const ms = performance.now() - resumedAt;
      const signature = planSignature(event.after);
      events.push({
        stage: event.stage,
        pass: event.pass,
        iteration: event.iteration,
        after: event.after,
        changed: signature !== previousSignature,
        ms,
        signature,
      });
      previousSignature = signature;
      resumedAt = performance.now();
    });
  } catch (caught) {
    error = { message: messageOf(caught), afterStep: events.length };
  }

  const repeats = repeatsOf(events);
  const snapshots: PlanSnapshot[] = [snapshotOf(logicalPlan, setup.metrics)];
  const steps: PassStep[] = events.map((event, index) => {
    snapshots.push(snapshotOf(event.after, setup.metrics));
    return {
      index,
      stage: event.stage,
      pass: event.pass,
      iteration: event.iteration,
      changed: event.changed,
      ms: event.ms,
      repeats: repeats[index],
      from: index,
      to: index + 1,
    };
  });

  return { snapshots, steps, error, totalMs: events.reduce((total, event) => total + event.ms, 0) };
}

function subjectOf(name: string, plan: LogicalPlanNode, setup: TraceSetup, context: OptimizationContext): TraceSubject {
  const optimize = runOptimizer(plan, setup, context);
  return { name, optimize, physical: setup.metrics.physical(finalPlanOf(optimize)) };
}

function cteSubjects(root: LogicalPlanNode, setup: TraceSetup): TraceSubject[] {
  const cteMap = root._cteMap;
  if (!cteMap || cteMap.size === 0) return [];

  const orderRequirements = cteScanOrderRequirements(root);
  for (const plan of cteMap.values()) cteScanOrderRequirements(plan, orderRequirements);

  return [...cteMap].map(([name, plan]) =>
    subjectOf(`CTE ${name}`, plan, setup, {
      rootOrderRequired: orderRequirements.get(name) ?? true,
    }));
}

export function traceQuery(
  sql: string,
  catalog: Catalog,
  statistics: Map<string, TableStats>,
  disabled: ReadonlySet<string> = NO_PASSES_DISABLED,
): TraceOutcome {
  const compiled = compile(sql, catalog);
  if (!compiled.ok) return compiled;

  const setup: TraceSetup = { catalog, statistics, metrics: new PlanMetrics(statistics), disabled };
  const root = compiled.value.logicalPlan;

  return {
    ok: true,
    trace: {
      sql,
      compiled: compiled.value,
      metrics: setup.metrics,
      disabled,
      subjects: [subjectOf(MAIN_SUBJECT, root, setup, {}), ...cteSubjects(root, setup)],
    },
  };
}

export function finalPlanOf(optimize: OptimizeTrace): LogicalPlanNode {
  return optimize.snapshots[optimize.snapshots.length - 1].plan;
}
