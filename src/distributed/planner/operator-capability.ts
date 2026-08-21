import { descriptorOf, InputRequirement, PartitioningEffect, type OperatorCapability } from '../../planner/plan-node-descriptor.js';
import type { PlanNodeType } from '../../planner/logical-plan.js';

export interface InputPartitioning {
  readonly combinedAbove: boolean;
  readonly groupsColocated: boolean;
}

export function capabilityOf(type: PlanNodeType): OperatorCapability {
  return descriptorOf(type).capability;
}

export function runsOnWorkers(capability: OperatorCapability, input: InputPartitioning): boolean {
  switch (capability.input) {
    case InputRequirement.ROW_LOCAL: return true;
    case InputRequirement.PARTIAL_THEN_COMBINE: return input.combinedAbove;
    case InputRequirement.COLOCATED_GROUPS: return input.groupsColocated;
    case InputRequirement.GLOBAL: return false;
  }
}

export function preservesPartitioning(capability: OperatorCapability): boolean {
  return capability.output === PartitioningEffect.PRESERVES;
}

export function preservesColocation(capability: OperatorCapability, childGroupsColocated: boolean): boolean {
  return preservesPartitioning(capability) && childGroupsColocated;
}
