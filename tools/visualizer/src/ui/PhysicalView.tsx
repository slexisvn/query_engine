import { physicalPlanToString, totalPhysicalCost } from '@engine/execution/physical-plan.js';
import { formatCount } from './format.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';

export interface PhysicalViewProps {
  physical: PhysicalPlanNode | null;
}

export function PhysicalView({ physical }: PhysicalViewProps) {
  if (!physical) {
    return (
      <div className="json-view">
        <header>
          <h4>Physical plan</h4>
          <p>The physical planner could not build a plan for this tree.</p>
        </header>
      </div>
    );
  }

  return (
    <div className="json-view">
      <header>
        <h4>Physical plan</h4>
        <p>
          Operator choices the physical planner made from the optimized logical plan — total cost{' '}
          {formatCount(totalPhysicalCost(physical))}.
        </p>
      </header>
      <pre>{physicalPlanToString(physical)}</pre>
    </div>
  );
}
