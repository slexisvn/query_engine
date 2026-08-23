import { buildStatistics, createDemoCatalog, DEFAULT_ROW_COUNTS } from '../../src/engine/demo-catalog.js';
import { traceQuery } from '../../src/engine/trace.js';
import { flattenPlanView, toPlanView } from '../../src/engine/plan-view.js';
import { diffPlans } from '../../src/engine/plan-diff.js';
import type { PipelineTrace, PassStep } from '../../src/engine/trace.js';
import type { PlanViewNode } from '../../src/engine/plan-view.js';
import type { PlanMatch } from '../../src/engine/plan-diff.js';

export function trace(sql: string): PipelineTrace {
  const outcome = traceQuery(sql, createDemoCatalog(), buildStatistics(DEFAULT_ROW_COUNTS));
  if (!outcome.ok) throw new Error(`${outcome.error.phase}: ${outcome.error.message}`);
  return outcome.trace;
}

export function mainTrace(pipeline: PipelineTrace) {
  return pipeline.subjects[0].optimize;
}

export function stepFor(pipeline: PipelineTrace, pass: string): PassStep {
  const step = mainTrace(pipeline).steps.find(candidate => candidate.pass === pass && candidate.changed);
  if (!step) throw new Error(`no changing step for pass ${pass}`);
  return step;
}

export const JOIN_TOPN_QUERY = `
  SELECT c.C_NAME, o.O_TOTALPRICE
  FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
  WHERE c.C_NAME = 'Customer#000000001' AND 1 = 1
  ORDER BY o.O_TOTALPRICE DESC
  LIMIT 10
`;

export function planViewsFor(pipeline: PipelineTrace, pass: string) {
  const step = stepFor(pipeline, pass);
  const before = toPlanView(mainTrace(pipeline).snapshots[step.from].plan);
  const after = toPlanView(mainTrace(pipeline).snapshots[step.to].plan);
  return { step, before, after, diff: diffPlans(before, after) };
}

export function statusesByType(root: PlanViewNode, lookup: Map<string, PlanMatch>): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  for (const node of flattenPlanView(root)) {
    const status = lookup.get(node.path)?.status ?? 'unmatched';
    const bucket = byType.get(node.type);
    if (bucket) bucket.push(status);
    else byType.set(node.type, [status]);
  }
  return byType;
}
