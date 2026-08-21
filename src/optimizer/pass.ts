import type { LogicalPlanNode } from '../planner/logical-plan.js';

export interface OptimizationContext {
  rootOrderRequired?: boolean;
}

export abstract class OptimizationPass {
  abstract get name(): string;

  abstract apply(plan: LogicalPlanNode, context?: OptimizationContext): LogicalPlanNode;
}
