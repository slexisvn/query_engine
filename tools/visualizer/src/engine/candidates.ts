import { cheapest } from '@engine/execution/physical-planner.js';
import { aggregateLogical, describePhysicalNode, isPhysicalAggregate, isPhysicalJoin } from '@engine/execution/physical-plan.js';
import type { PhysicalPlanner } from '@engine/execution/physical-planner.js';
import type { PhysicalNodeType, PhysicalPlanNode } from '@engine/execution/physical-plan.js';

export interface OperatorCandidate {
  type: PhysicalNodeType;
  label: string;
  cost: number;
  chosen: boolean;
}

export interface OperatorChoice {
  candidates: OperatorCandidate[];
  runnerUpMargin: number | null;
  agreesWithPlan: boolean;
}

function candidatePlans(planner: PhysicalPlanner, node: PhysicalPlanNode): PhysicalPlanNode[] {
  try {
    if (isPhysicalJoin(node)) return planner.joinCandidates(node.logical, node.children);
    if (isPhysicalAggregate(node)) return planner.aggregateCandidates(aggregateLogical(node), node.children);
  } catch {
    return [];
  }
  return [];
}

export function operatorChoice(planner: PhysicalPlanner, node: PhysicalPlanNode): OperatorChoice | null {
  const plans = candidatePlans(planner, node);
  if (plans.length === 0) return null;

  const winner = plans.find(candidate => candidate.type === node.type) ?? cheapest(plans);
  const ranked = [...plans].sort((a, b) => a.cost - b.cost);
  const runnerUp = ranked.find(candidate => candidate !== winner) ?? null;

  return {
    candidates: ranked.map(candidate => ({
      type: candidate.type,
      label: describePhysicalNode(candidate),
      cost: candidate.cost,
      chosen: candidate === winner,
    })),
    runnerUpMargin: runnerUp === null || winner.cost <= 0 ? null : (runnerUp.cost - winner.cost) / winner.cost,
    agreesWithPlan: cheapest(plans).type === node.type,
  };
}
