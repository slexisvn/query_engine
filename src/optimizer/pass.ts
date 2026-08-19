import type { LogicalPlanNode } from '../planner/logical-plan.js';

export type OptimizationContext = Record<string, never>;

export abstract class OptimizationPass {
  abstract get name(): string;

  abstract apply(plan: LogicalPlanNode, context?: OptimizationContext): LogicalPlanNode;
}
