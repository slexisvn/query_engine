import { describe, it, expect } from 'vitest';
import { PhysicalNodeType, isPhysicalJoin, totalPhysicalCost } from '@engine/execution/physical-plan.js';
import { costBreakdown } from '../../src/engine/cost-breakdown.js';
import { costShareOf, planRows, planTotalCost } from '../../src/engine/profile-view.js';
import { trace } from './helpers.js';
import type { CostTermView } from '../../src/engine/cost-breakdown.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';
import type { PipelineTrace } from '../../src/engine/trace.js';

const JOIN_QUERY = `
  SELECT c.C_NAME, o.O_TOTALPRICE
  FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
  WHERE c.C_MKTSEGMENT = 'BUILDING'
  ORDER BY o.O_TOTALPRICE DESC
  LIMIT 10
`;

const GROUPED_QUERY = 'SELECT O_ORDERSTATUS, COUNT(*) AS N FROM ORDERS GROUP BY O_ORDERSTATUS';

function physicalOf(pipeline: PipelineTrace): PhysicalPlanNode {
  const physical = pipeline.subjects[0].physical;
  if (!physical) throw new Error('no physical plan');
  return physical;
}

function flatten(node: PhysicalPlanNode, into: PhysicalPlanNode[] = []): PhysicalPlanNode[] {
  into.push(node);
  for (const child of node.children) flatten(child, into);
  return into;
}

function sumTerms(terms: readonly CostTermView[]): number {
  return terms.reduce((total, term) => total + term.value, 0);
}

describe('cost breakdown', () => {
  it('reconstructs the cost the planner put on the node', () => {
    const pipeline = trace(JOIN_QUERY);

    for (const node of flatten(physicalOf(pipeline))) {
      const breakdown = costBreakdown(pipeline.metrics.planner, node);
      if (breakdown === null) continue;
      expect(sumTerms(breakdown.terms)).toBeCloseTo(node.cost);
      expect(breakdown.total).toBe(node.cost);
    }
  });

  it('names the primitives a hash join was priced with', () => {
    const pipeline = trace(JOIN_QUERY);
    const join = flatten(physicalOf(pipeline)).find(isPhysicalJoin);
    const breakdown = costBreakdown(pipeline.metrics.planner, join!);

    expect(breakdown).not.toBeNull();
    expect(breakdown!.terms.map(term => term.method)).toEqual(['hashJoinCost']);
    expect(breakdown!.terms[0].children.map(term => term.method))
      .toEqual(['hashBuildCost', 'hashProbeCost', 'joinOutputCost', 'spillPenalty']);
  });

  it('shares out each primitive against the node total', () => {
    const pipeline = trace(JOIN_QUERY);
    const join = flatten(physicalOf(pipeline)).find(isPhysicalJoin);
    const breakdown = costBreakdown(pipeline.metrics.planner, join!);
    const children = breakdown!.terms[0].children;

    expect(children.reduce((total, term) => total + term.share, 0)).toBeCloseTo(1);
    expect(children.every(term => term.share >= 0)).toBe(true);
  });

  it('carries the cardinalities the primitive was called with', () => {
    const pipeline = trace(JOIN_QUERY);
    const join = flatten(physicalOf(pipeline)).find(isPhysicalJoin);
    const breakdown = costBreakdown(pipeline.metrics.planner, join!);

    expect(breakdown!.terms[0].args).toContain(join!.cardinality);
  });

  it('prices a scan off its own cardinality', () => {
    const pipeline = trace(JOIN_QUERY);
    const scan = flatten(physicalOf(pipeline)).find(node => node.type === PhysicalNodeType.TABLE_SCAN);
    const breakdown = costBreakdown(pipeline.metrics.planner, scan!);

    expect(breakdown!.terms.map(term => term.method)).toEqual(['scanCost']);
    expect(breakdown!.terms[0].value).toBeCloseTo(scan!.cost);
  });

  it('prices a grouped aggregate', () => {
    const pipeline = trace(GROUPED_QUERY);
    const aggregate = flatten(physicalOf(pipeline))
      .find(node => node.type === PhysicalNodeType.HASH_AGGREGATE || node.type === PhysicalNodeType.PERFECT_HASH_AGGREGATE);
    const breakdown = costBreakdown(pipeline.metrics.planner, aggregate!);

    expect(breakdown).not.toBeNull();
    expect(sumTerms(breakdown!.terms)).toBeCloseTo(aggregate!.cost);
  });

  it('leaves the planner cost model exactly as it found it', () => {
    const pipeline = trace(JOIN_QUERY);
    const planner = pipeline.metrics.planner;
    const before = planner.costModel;
    const physical = physicalOf(pipeline);

    costBreakdown(planner, physical);

    expect(planner.costModel).toBe(before);
    expect(planner.plan(pipeline.subjects[0].optimize.snapshots.at(-1)!.plan).cost).toBe(physical.cost);
  });

  it('shares out cost against every root the profile holds', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = planRows(physicalOf(pipeline), pipeline.metrics.planner);
    const shares = rows.reduce((total, row) => total + costShareOf(rows, row), 0);

    expect(planTotalCost(rows)).toBeCloseTo(totalPhysicalCost(physicalOf(pipeline)));
    expect(shares).toBeCloseTo(1);
  });

  it('keeps the subtree total consistent with the per-node costs it explains', () => {
    const pipeline = trace(JOIN_QUERY);
    const physical = physicalOf(pipeline);
    const selfCosts = flatten(physical).reduce((total, node) => total + node.cost, 0);

    expect(totalPhysicalCost(physical)).toBeCloseTo(selfCosts);
  });
});
