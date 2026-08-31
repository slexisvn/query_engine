import { getChildren, type LogicalPlanNode } from '../planner/logical-plan.js';

const INTERNAL_FIELD_PREFIX = '_';
const CHILDREN_FIELD = 'children';

const CACHE = new WeakMap<LogicalPlanNode, string>();

function ownFieldValue(key: string, value: unknown): unknown {
  if (key.startsWith(INTERNAL_FIELD_PREFIX) || key === CHILDREN_FIELD) return undefined;
  if (typeof value === 'bigint') return `${value}n`;
  return value;
}

export function planSignature(plan: LogicalPlanNode): string {
  const cached = CACHE.get(plan);
  if (cached !== undefined) return cached;

  const children = getChildren(plan);
  const own = JSON.stringify(plan, ownFieldValue);
  const signature = children.length === 0
    ? own
    : `${own}(${children.map(planSignature).join(',')})`;

  CACHE.set(plan, signature);
  return signature;
}
