import { describe, it, expect } from 'vitest';
import { PhysicalNodeType, isPhysicalJoin } from '@engine/execution/physical-plan.js';
import { operatorChoice } from '../../src/engine/candidates.js';
import { trace } from './helpers.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';
import type { PipelineTrace } from '../../src/engine/trace.js';

const JOIN_QUERY = `
  SELECT c.C_NAME, o.O_TOTALPRICE
  FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
`;

const GROUPED_QUERY = `
  SELECT o.O_ORDERSTATUS, COUNT(*) AS N
  FROM ORDERS o
  GROUP BY o.O_ORDERSTATUS
`;

const CROSS_QUERY = 'SELECT n.N_NAME, r.R_NAME FROM NATION n, REGION r';

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

function nodeOfType(pipeline: PipelineTrace, type: PhysicalNodeType): PhysicalPlanNode {
  const found = flatten(physicalOf(pipeline)).find(node => node.type === type);
  if (!found) throw new Error(`no ${type} in the physical plan`);
  return found;
}

function firstJoin(pipeline: PipelineTrace): PhysicalPlanNode {
  const found = flatten(physicalOf(pipeline)).find(isPhysicalJoin);
  if (!found) throw new Error('no join in the physical plan');
  return found;
}

describe('operator candidates', () => {
  it('offers the losing join strategies beside the winner', () => {
    const pipeline = trace(JOIN_QUERY);
    const join = firstJoin(pipeline);
    const choice = operatorChoice(pipeline.metrics.planner, join);

    expect(choice).not.toBeNull();
    expect(choice!.candidates.length).toBeGreaterThan(1);
    expect(choice!.candidates.filter(candidate => candidate.chosen)).toHaveLength(1);
  });

  it('marks the candidate that the plan actually used', () => {
    const pipeline = trace(JOIN_QUERY);
    const join = firstJoin(pipeline);
    const choice = operatorChoice(pipeline.metrics.planner, join);

    expect(choice!.candidates.find(candidate => candidate.chosen)!.type).toBe(join.type);
    expect(choice!.agreesWithPlan).toBe(true);
  });

  it('ranks candidates cheapest first', () => {
    const pipeline = trace(JOIN_QUERY);
    const choice = operatorChoice(pipeline.metrics.planner, firstJoin(pipeline));
    const costs = choice!.candidates.map(candidate => candidate.cost);

    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });

  it('measures how far ahead of the runner-up the winner finished', () => {
    const pipeline = trace(JOIN_QUERY);
    const choice = operatorChoice(pipeline.metrics.planner, firstJoin(pipeline));
    const [winner, runnerUp] = choice!.candidates;

    expect(choice!.runnerUpMargin).toBeCloseTo((runnerUp.cost - winner.cost) / winner.cost);
    expect(choice!.runnerUpMargin).toBeGreaterThanOrEqual(0);
  });

  it('keeps merge join out of a join that has no equi keys', () => {
    const pipeline = trace(CROSS_QUERY);
    const choice = operatorChoice(pipeline.metrics.planner, firstJoin(pipeline));
    const types = choice!.candidates.map(candidate => candidate.type);

    expect(types).not.toContain(PhysicalNodeType.MERGE_JOIN);
    expect(types).toContain(PhysicalNodeType.HASH_JOIN);
  });

  it('offers the aggregate strategies for a grouped aggregate', () => {
    const pipeline = trace(GROUPED_QUERY);
    const aggregate = flatten(physicalOf(pipeline)).find(node =>
      node.type === PhysicalNodeType.HASH_AGGREGATE || node.type === PhysicalNodeType.PERFECT_HASH_AGGREGATE);
    const choice = operatorChoice(pipeline.metrics.planner, aggregate!);

    expect(choice).not.toBeNull();
    expect(choice!.candidates.map(candidate => candidate.type)).toContain(PhysicalNodeType.HASH_AGGREGATE);
  });

  it('has nothing to decide for a scan', () => {
    const pipeline = trace(JOIN_QUERY);
    const scan = nodeOfType(pipeline, PhysicalNodeType.TABLE_SCAN);

    expect(operatorChoice(pipeline.metrics.planner, scan)).toBeNull();
  });

  it('labels a join candidate with its build side', () => {
    const pipeline = trace(JOIN_QUERY);
    const choice = operatorChoice(pipeline.metrics.planner, firstJoin(pipeline));
    const hashJoin = choice!.candidates.find(candidate => candidate.type === PhysicalNodeType.HASH_JOIN);

    expect(hashJoin!.label).toMatch(/build=(left|right)/);
  });
});
