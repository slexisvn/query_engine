import { Config } from '@engine/config.js';
import { getChildren, PlanNodeType } from '@engine/planner/logical-plan.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';

export type EnumeratorKind = 'DPhyp' | 'greedy';

export interface JoinCluster {
  relations: number;
  enumerator: EnumeratorKind;
}

export interface JoinOrderNote {
  clusters: JoinCluster[];
  dpLimit: number;
}

function joinsIn(node: LogicalPlanNode): number {
  let total = 1;
  for (const child of getChildren(node)) {
    if (child.type === PlanNodeType.JOIN) total += joinsIn(child);
  }
  return total;
}

function collectClusters(node: LogicalPlanNode, into: JoinCluster[], dpLimit: number): void {
  if (node.type === PlanNodeType.JOIN) {
    const relations = joinsIn(node) + 1;
    into.push({ relations, enumerator: relations <= dpLimit ? 'DPhyp' : 'greedy' });
  }

  for (const child of getChildren(node)) {
    if (node.type === PlanNodeType.JOIN && child.type === PlanNodeType.JOIN) continue;
    collectClusters(child, into, dpLimit);
  }
}

export function joinOrderNote(plan: LogicalPlanNode): JoinOrderNote {
  const dpLimit = Config.joinOrderDpMaxRelations;
  const clusters: JoinCluster[] = [];
  collectClusters(plan, clusters, dpLimit);
  return { clusters, dpLimit };
}
