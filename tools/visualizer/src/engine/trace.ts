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
}

export interface TraceSubject {
  name: string;
  optimize: OptimizeTrace;
  physical: PhysicalPlanNode | null;
}

export interface PipelineTrace {
  sql: string;
  compiled: CompiledQuery;
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotOf(plan: LogicalPlanNode, metrics: PlanMetrics): PlanSnapshot {
  return { plan, display: metrics.annotate(plan), nodes: countNodes(plan), cost: metrics.cost(plan) };
}

function runOptimizer(
  logicalPlan: LogicalPlanNode,
  catalog: Catalog,
  statistics: Map<string, TableStats>,
  metrics: PlanMetrics,
  context: OptimizationContext,
): OptimizeTrace {
  const optimizer = createDefaultOptimizer({ catalog, statistics });
  const events: RawEvent[] = [];
  let previousSignature = planSignature(logicalPlan);

  let error: OptimizeFailure | null = null;
  try {
    optimizer.optimize(logicalPlan, context, event => {
      const signature = planSignature(event.after);
      events.push({
        stage: event.stage,
        pass: event.pass,
        iteration: event.iteration,
        after: event.after,
        changed: signature !== previousSignature,
      });
      previousSignature = signature;
    });
  } catch (caught) {
    error = { message: messageOf(caught), afterStep: events.length };
  }

  const snapshots: PlanSnapshot[] = [snapshotOf(logicalPlan, metrics)];
  const steps: PassStep[] = events.map((event, index) => {
    snapshots.push(snapshotOf(event.after, metrics));
    return {
      index,
      stage: event.stage,
      pass: event.pass,
      iteration: event.iteration,
      changed: event.changed,
      from: index,
      to: index + 1,
    };
  });

  return { snapshots, steps, error };
}

function subjectOf(
  name: string,
  plan: LogicalPlanNode,
  catalog: Catalog,
  statistics: Map<string, TableStats>,
  metrics: PlanMetrics,
  context: OptimizationContext,
): TraceSubject {
  const optimize = runOptimizer(plan, catalog, statistics, metrics, context);
  return { name, optimize, physical: metrics.physical(finalPlanOf(optimize)) };
}

function cteSubjects(
  root: LogicalPlanNode,
  catalog: Catalog,
  statistics: Map<string, TableStats>,
  metrics: PlanMetrics,
): TraceSubject[] {
  const cteMap = root._cteMap;
  if (!cteMap || cteMap.size === 0) return [];

  const orderRequirements = cteScanOrderRequirements(root);
  for (const plan of cteMap.values()) cteScanOrderRequirements(plan, orderRequirements);

  return [...cteMap].map(([name, plan]) =>
    subjectOf(`CTE ${name}`, plan, catalog, statistics, metrics, {
      rootOrderRequired: orderRequirements.get(name) ?? true,
    }));
}

export function traceQuery(sql: string, catalog: Catalog, statistics: Map<string, TableStats>): TraceOutcome {
  const compiled = compile(sql, catalog);
  if (!compiled.ok) return compiled;

  const metrics = new PlanMetrics(statistics);
  const root = compiled.value.logicalPlan;

  return {
    ok: true,
    trace: {
      sql,
      compiled: compiled.value,
      subjects: [
        subjectOf(MAIN_SUBJECT, root, catalog, statistics, metrics, {}),
        ...cteSubjects(root, catalog, statistics, metrics),
      ],
    },
  };
}

export function finalPlanOf(optimize: OptimizeTrace): LogicalPlanNode {
  return optimize.snapshots[optimize.snapshots.length - 1].plan;
}
