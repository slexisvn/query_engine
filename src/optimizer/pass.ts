import type { LogicalPlanNode } from '../planner/logical-plan.js';

export class OptimizationPass {
  get name(): string {
    throw new Error('Subclass must implement name');
  }

  apply(plan: LogicalPlanNode, context?: Record<string, never>): LogicalPlanNode {
    throw new Error('Subclass must implement apply()');
  }
}
