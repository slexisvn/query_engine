import type { LogicalPlanNode } from '../planner/logical-plan.js';

const INTERNAL_FIELD_PREFIX = '_';

function stableValue(key: string, value: unknown): unknown {
  if (key.startsWith(INTERNAL_FIELD_PREFIX)) return undefined;
  if (typeof value === 'bigint') return `${value}n`;
  return value;
}

export function planSignature(plan: LogicalPlanNode): string {
  return JSON.stringify(plan, stableValue);
}
