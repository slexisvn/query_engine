import { CostRecorder, childIndexesOf, topLevelIndexes } from '@engine/planner/cost-recorder.js';
import { aggregateLogical, isPhysicalAggregate, isPhysicalJoin, PhysicalNodeType } from '@engine/execution/physical-plan.js';
import { PlanNodeType } from '@engine/planner/logical-plan.js';
import type { CostTerm } from '@engine/planner/cost-recorder.js';
import type { PhysicalPlanner } from '@engine/execution/physical-planner.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';

const RELATIVE_TOLERANCE = 1e-9;

export interface CostTermView {
  method: string;
  args: readonly unknown[];
  value: number;
  share: number;
  children: CostTermView[];
}

export interface CostBreakdown {
  total: number;
  terms: CostTermView[];
}

function costTypeOf(node: PhysicalPlanNode): PlanNodeType {
  return node.type === PhysicalNodeType.LIMIT && node.logical.type === PlanNodeType.TOP_N
    ? PlanNodeType.LIMIT
    : node.logical.type;
}

function recordTerms(planner: PhysicalPlanner, node: PhysicalPlanNode): CostTerm[] {
  const original = planner.costModel;
  const recorder = new CostRecorder(original);
  planner.costModel = recorder.model;

  try {
    return recorder.collect(() => {
      if (isPhysicalJoin(node)) planner.joinCandidates(node.logical, node.children);
      else if (isPhysicalAggregate(node)) planner.aggregateCandidates(aggregateLogical(node), node.children);
      else planner.operatorCost(node.logical, node.children, costTypeOf(node));
    });
  } catch {
    return [];
  } finally {
    planner.costModel = original;
  }
}

function isClose(value: number, target: number): boolean {
  return Math.abs(value - target) <= Math.max(RELATIVE_TOLERANCE, Math.abs(target) * RELATIVE_TOLERANCE);
}

function runMatching(terms: readonly CostTerm[], target: number): number[] | null {
  const tops = topLevelIndexes(terms);
  const prefix = [0];
  for (const index of tops) prefix.push(prefix[prefix.length - 1] + terms[index].value);

  for (let length = 1; length <= tops.length; length++) {
    for (let start = 0; start + length <= tops.length; start++) {
      if (isClose(prefix[start + length] - prefix[start], target)) return tops.slice(start, start + length);
    }
  }
  return null;
}

function viewOf(terms: readonly CostTerm[], index: number, total: number): CostTermView {
  const term = terms[index];
  return {
    method: term.method,
    args: term.args,
    value: term.value,
    share: total === 0 ? 0 : term.value / total,
    children: childIndexesOf(terms, index).map(child => viewOf(terms, child, total)),
  };
}

export function costBreakdown(planner: PhysicalPlanner, node: PhysicalPlanNode): CostBreakdown | null {
  const terms = recordTerms(planner, node);
  if (terms.length === 0) return null;

  const run = runMatching(terms, node.cost);
  if (run === null) return null;

  return { total: node.cost, terms: run.map(index => viewOf(terms, index, node.cost)) };
}
