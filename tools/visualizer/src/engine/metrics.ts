import { PhysicalPlanner } from '@engine/execution/physical-planner.js';
import { totalPhysicalCost } from '@engine/execution/physical-plan.js';
import { PlanPropertyAnnotator } from '@engine/planner/plan-properties.js';
import { getChildren } from '@engine/planner/logical-plan.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';
import type { TableStats } from '@engine/catalog/statistics.js';

export function countNodes(plan: LogicalPlanNode): number {
  let total = 1;
  for (const child of getChildren(plan)) total += countNodes(child);
  return total;
}

export class PlanMetrics {
  private readonly planner: PhysicalPlanner;
  private readonly annotator: PlanPropertyAnnotator;

  constructor(statistics: Map<string, TableStats>) {
    this.planner = new PhysicalPlanner(statistics);
    this.annotator = new PlanPropertyAnnotator(statistics);
  }

  annotate(plan: LogicalPlanNode): LogicalPlanNode {
    try {
      return this.annotator.annotate(plan);
    } catch {
      return plan;
    }
  }

  physical(plan: LogicalPlanNode): PhysicalPlanNode | null {
    try {
      return this.planner.plan(plan);
    } catch {
      return null;
    }
  }

  cost(plan: LogicalPlanNode): number | null {
    const physical = this.physical(plan);
    return physical === null ? null : totalPhysicalCost(physical);
  }
}
